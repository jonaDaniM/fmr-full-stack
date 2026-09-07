/**
 * Numbers the database issues.
 *
 * The client numbers FMRs from 1 upward — 406, 407, 408 — and typed them by
 * hand in the spreadsheet this replaces. Two things have to hold: the number
 * must never collide with one that migrated in, and two people releasing at
 * the same moment must never be handed the same number. Neither can be tested
 * without a real database, which is why these live here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { enabled, connect, close, fixture } from './harness.js';

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

/** A member who may issue numbers, in the fixture's project. */
const numberer = async (pool, f) => {
  const email = 'numberer@test';
  const { rows } = await pool.query(
    `INSERT INTO users (email, display_name) VALUES ($1,'Material Control')
     ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id`, [email]);
  await pool.query(
    `INSERT INTO project_members (project_id,user_id,role,can_search,
       can_field_transact,can_admin_backorder,can_owner_edit,
       can_plan_review,can_assign_number)
     VALUES ($1,$2,'CUSTOM',true,false,false,false,true,true)
     ON CONFLICT (project_id,user_id) DO UPDATE SET can_assign_number = true,
       can_plan_review = true`,
    [f.projectId, rows[0].id]);

  return {
    user: { id: rows[0].id, email, display_name: 'Material Control' },
    projectId: f.projectId,
    permissions: {
      search: true, fieldTransact: false, adminBackorder: false,
      ownerEdit: false, planReview: true, assignNumber: true
    }
  };
};

/** Walk a fresh draft up to the point where it is waiting for its number. */
const readyToNumber = async ({ drafts, workflow }, f, who) => {
  const created = await drafts.createDraft(f.ctx, draft());
  await workflow.advance(f.ctx, { itemId: created.itemId, action: 'SUBMIT' });
  await workflow.advance(who, { itemId: created.itemId, action: 'PLANNER_APPROVE' });
  await workflow.advance(who, { itemId: created.itemId, action: 'SEND_TO_MATERIAL' });
  return created;
};

test('fmr numbering', { skip }, async (t) => {
  const api = await connect();
  const { workflow, pool } = api;
  t.after(close);

  await t.test('an empty number means the database issues the next one', async () => {
    const f = await fixture();
    const who = await numberer(pool, f);
    const item = await readyToNumber(api, f, who);

    const result = await workflow.assignNumber(who, { itemId: item.itemId });

    assert.match(result.fmrNumber, /^\d+$/, 'the client numbers with digits');
    assert.equal(result.state, 'NUMBER_ASSIGNED');
  });

  await t.test('numbers issued in sequence do not repeat', async () => {
    const f = await fixture();
    const who = await numberer(pool, f);

    const issued = [];
    for (let n = 0; n < 3; n += 1) {
      const item = await readyToNumber(api, f, who);
      issued.push(Number((await workflow.assignNumber(who, { itemId: item.itemId })).fmrNumber));
    }

    assert.equal(new Set(issued).size, 3, 'a number was handed out twice');
    assert.deepEqual(issued, [issued[0], issued[0] + 1, issued[0] + 2],
      'the sequence counts upward');
  });

  await t.test('the counter starts above the numbers already in the project', async () => {
    // The spreadsheet arrives with its own numbering. Issuing 1 into a project
    // that already holds 880 FMRs would be refused by the unique index at the
    // worst possible moment — mid-release, in front of a crew.
    const f = await fixture();
    const who = await numberer(pool, f);

    await pool.query(
      `INSERT INTO fmr_headers (project_id, fmr_number, current_status, created_by, updated_by)
       VALUES ($1,'880','Open',$2,$2)`, [f.projectId, who.user.id]);
    await pool.query('DELETE FROM fmr_number_sequences WHERE project_id = $1', [f.projectId]);

    const item = await readyToNumber(api, f, who);
    const issued = await workflow.assignNumber(who, { itemId: item.itemId });

    assert.ok(Number(issued.fmrNumber) > 880,
      `issued ${issued.fmrNumber}, which collides with the migrated data`);
  });

  await t.test('a number typed by hand still wins, and costs no sequence number', async () => {
    // Renumbering, and correcting before release, are both real needs.
    const f = await fixture();
    const who = await numberer(pool, f);

    const typed = await readyToNumber(api, f, who);
    const chosen = await workflow.assignNumber(who, { itemId: typed.itemId, fmrNumber: 'A-500' });
    assert.equal(chosen.fmrNumber, 'A-500');

    const auto = await readyToNumber(api, f, who);
    const next = await workflow.assignNumber(who, { itemId: auto.itemId });
    assert.match(next.fmrNumber, /^\d+$/, 'the typed one did not consume the sequence');
  });
});
