/**
 * The approval chain against a real database.
 *
 * The rules are tested pure in workflow.test.js. These are the parts that
 * only exist once there is a database underneath: that publishing is actually
 * refused, that the number is actually held by material control, and that
 * "who approved this" can actually be answered afterwards.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { enabled, connect, close, fixture } from './harness.js';
import { STATES } from '../../src/domain/workflow.js';

const skip = enabled ? false : 'set FMR_TEST_DATABASE_URL to run';

const draft = (over = {}) => ({
  header: {
    fmrNumber: null, isoNumber: 'D-4410', isoSheet: '01',
    requestedBy: 'Dale Hughes', ...over.header
  },
  lines: over.lines ?? [
    { commodityCode: 'PF-A106', size: '6"', description: 'PIPE, CS A106 GR B',
      quantity: '120', uom: 'FT' }
  ]
});

/** A member with exactly the permissions named, in the fixture's project. */
const asRole = async (pool, f, flags) => {
  const email = `${Object.keys(flags).join('-') || 'none'}@test`;
  const { rows } = await pool.query(
    `INSERT INTO users (email, display_name) VALUES ($1,$2)
     ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id`, [email, 'Test Person']);
  const userId = rows[0].id;

  await pool.query(
    `INSERT INTO project_members (project_id,user_id,role,can_search,
       can_field_transact,can_admin_backorder,can_owner_edit,
       can_plan_review,can_assign_number)
     VALUES ($1,$2,'CUSTOM',true,false,false,$3,$4,$5)
     ON CONFLICT (project_id,user_id) DO UPDATE SET
       can_owner_edit = EXCLUDED.can_owner_edit,
       can_plan_review = EXCLUDED.can_plan_review,
       can_assign_number = EXCLUDED.can_assign_number`,
    [f.projectId, userId, !!flags.ownerEdit, !!flags.planReview, !!flags.assignNumber]);

  return {
    user: { id: userId, email, display_name: 'Test Person' },
    projectId: f.projectId,
    permissions: {
      search: true, fieldTransact: false, adminBackorder: false,
      ownerEdit: !!flags.ownerEdit,
      planReview: !!flags.planReview,
      assignNumber: !!flags.assignNumber
    }
  };
};

test('approval chain', { skip }, async (t) => {
  const { drafts, workflow, staging, pool } = await connect();
  t.after(close);

  await t.test('a drawing cannot reach a crew without both approvals', async () => {
    const f = await fixture();
    const created = await drafts.createDraft(f.ctx, draft());

    // Straight to publish, the way it worked before the chain existed.
    const failure = await staging.publishBatch(f.ctx, { batchId: created.batchId })
      .then(() => null, (error) => error);

    assert.ok(failure, 'an unapproved FMR was published to the field');
    assert.equal(failure.code, 'NOT_APPROVED');
    assert.match(failure.message, /planner/i, 'the message has to say what is missing');
  });

  await t.test('the whole chain, and only then the field sees it', async () => {
    const f = await fixture();
    const created = await drafts.createDraft(f.ctx, draft());

    const planner = await asRole(pool, f, { planReview: true });
    const material = await asRole(pool, f, { assignNumber: true });

    await workflow.advance(f.ctx, { itemId: created.itemId, action: 'SUBMIT' });
    await workflow.advance(planner, { itemId: created.itemId, action: 'PLANNER_APPROVE' });
    await workflow.advance(planner, { itemId: created.itemId, action: 'SEND_TO_MATERIAL' });
    await workflow.assignNumber(material, { itemId: created.itemId, fmrNumber: 'FMR-971' });

    const published = await staging.publishBatch(material, { batchId: created.batchId });
    assert.equal(published.count, 1);
    assert.equal(published.published[0].fmrNumber, 'FMR-971');

    // And it is now a real FMR the field can search.
    const { rows } = await pool.query(
      'SELECT fmr_number FROM fmr_headers WHERE project_id = $1 AND fmr_number = $2',
      [f.projectId, 'FMR-971']);
    assert.equal(rows.length, 1);
  });

  await t.test('a planner cannot give it a number', async () => {
    const f = await fixture();
    const created = await drafts.createDraft(f.ctx, draft());
    const planner = await asRole(pool, f, { planReview: true });

    await workflow.advance(f.ctx, { itemId: created.itemId, action: 'SUBMIT' });
    await workflow.advance(planner, { itemId: created.itemId, action: 'PLANNER_APPROVE' });
    await workflow.advance(planner, { itemId: created.itemId, action: 'SEND_TO_MATERIAL' });

    const failure = await workflow.assignNumber(planner, {
      itemId: created.itemId, fmrNumber: 'FMR-000'
    }).then(() => null, (error) => error);

    assert.ok(failure, 'a planner assigned the release identifier');
    assert.equal(failure.code, 'FORBIDDEN');
  });

  await t.test('a returned request goes back to the planner, not to the field', async () => {
    const f = await fixture();
    const created = await drafts.createDraft(f.ctx, draft());
    const planner = await asRole(pool, f, { planReview: true });

    await workflow.advance(f.ctx, { itemId: created.itemId, action: 'SUBMIT' });
    await workflow.advance(planner, {
      itemId: created.itemId, action: 'PLANNER_RETURN',
      reason: 'valves belong to the next work package'
    });

    const failure = await staging.publishBatch(f.ctx, { batchId: created.batchId })
      .then(() => null, (error) => error);
    assert.ok(failure, 'a returned request was published');
    assert.equal(failure.code, 'NOT_APPROVED');

    // Corrected and resubmitted, it re-enters review rather than skipping it.
    const back = await workflow.advance(f.ctx, { itemId: created.itemId, action: 'SUBMIT' });
    assert.equal(back.state, STATES.PENDING_PLANNER_REVIEW);
  });

  await t.test('who approved, who numbered, and when, are all answerable', async () => {
    const f = await fixture();
    const created = await drafts.createDraft(f.ctx, draft());
    const planner = await asRole(pool, f, { planReview: true });
    const material = await asRole(pool, f, { assignNumber: true });

    await workflow.advance(f.ctx, { itemId: created.itemId, action: 'SUBMIT' });
    await workflow.advance(planner, { itemId: created.itemId, action: 'PLANNER_APPROVE' });
    await workflow.advance(planner, { itemId: created.itemId, action: 'SEND_TO_MATERIAL' });
    await workflow.assignNumber(material, { itemId: created.itemId, fmrNumber: 'FMR-972' });

    const { rows } = await pool.query(
      `SELECT planner_decided_by, planner_decided_at, numbered_by, numbered_at
         FROM import_items WHERE id = $1`, [created.itemId]);
    assert.equal(rows[0].planner_decided_by, planner.user.id);
    assert.ok(rows[0].planner_decided_at, 'no time on the planner decision');
    assert.equal(rows[0].numbered_by, material.user.id);
    assert.ok(rows[0].numbered_at);

    const audit = await pool.query(
      `SELECT action, user_email FROM audit_log
        WHERE entity_id = $1 AND action LIKE 'WORKFLOW%' ORDER BY created_at`,
      [created.itemId]);
    assert.deepEqual(audit.rows.map((r) => r.action), [
      'WORKFLOW_SUBMIT', 'WORKFLOW_PLANNER_APPROVE',
      'WORKFLOW_SEND_TO_MATERIAL', 'WORKFLOW_ASSIGN_NUMBER'
    ]);
    assert.equal(audit.rows[1].user_email, planner.user.email);
    assert.equal(audit.rows[3].user_email, material.user.email);
  });

  await t.test('a request with errors is not sent to waste the planner\'s time', async () => {
    const f = await fixture();
    const created = await drafts.createDraft(f.ctx, draft({
      lines: [{ description: 'PIPE, CS A106 GR B', quantity: '', uom: 'FT' }]
    }));

    const failure = await workflow.advance(f.ctx, { itemId: created.itemId, action: 'SUBMIT' })
      .then(() => null, (error) => error);
    assert.ok(failure, 'a draft with no quantity went to review');
    assert.equal(failure.code, 'HAS_ERRORS');
  });

  await t.test('a number already live is refused before it can be reused', async () => {
    const f = await fixture();   // fixture publishes FMR-001 into fmr_headers
    const created = await drafts.createDraft(f.ctx, draft());
    const material = await asRole(pool, f, { assignNumber: true, planReview: true });

    await workflow.advance(f.ctx, { itemId: created.itemId, action: 'SUBMIT' });
    await workflow.advance(material, { itemId: created.itemId, action: 'PLANNER_APPROVE' });
    await workflow.advance(material, { itemId: created.itemId, action: 'SEND_TO_MATERIAL' });

    const failure = await workflow.assignNumber(material, {
      itemId: created.itemId, fmrNumber: 'FMR-001'
    }).then(() => null, (error) => error);

    assert.ok(failure, 'a published number was handed to a second requisition');
    assert.equal(failure.code, 'NUMBER_IN_USE');
  });

  await t.test('each queue shows only what is waiting on that person', async () => {
    const f = await fixture();
    const a = await drafts.createDraft(f.ctx, draft());
    const b = await drafts.createDraft(f.ctx, draft({ header: { isoSheet: '02' } }));

    const planner = await asRole(pool, f, { planReview: true });
    const material = await asRole(pool, f, { assignNumber: true });

    await workflow.advance(f.ctx, { itemId: a.itemId, action: 'SUBMIT' });
    await workflow.advance(planner, { itemId: a.itemId, action: 'PLANNER_APPROVE' });
    await workflow.advance(planner, { itemId: a.itemId, action: 'SEND_TO_MATERIAL' });
    await workflow.advance(f.ctx, { itemId: b.itemId, action: 'SUBMIT' });

    const client = await pool.connect();
    try {
      const forPlanner = await workflow.reviewQueue(client, planner);
      assert.deepEqual(forPlanner.items.map((i) => i.id), [b.itemId],
        'the planner was shown work that is not theirs');

      const forMaterial = await workflow.reviewQueue(client, material);
      assert.deepEqual(forMaterial.items.map((i) => i.id), [a.itemId]);

      // And each is offered only the moves they can actually make.
      assert.deepEqual(forPlanner.items[0].actions.map((x) => x.action).sort(),
        ['PLANNER_APPROVE', 'PLANNER_RETURN']);
      assert.deepEqual(forMaterial.items[0].actions.map((x) => x.action),
        ['ASSIGN_NUMBER']);
    } finally {
      client.release();
    }
  });
});
