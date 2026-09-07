/**
 * Moving an FMR through the approval chain.
 *
 * The rules are in `domain/workflow.js` and know nothing about the database.
 * This is where they meet it: one transaction per move, the row locked while
 * the decision is made, and an audit row for every step — because "who
 * approved this, and when" is the question the chain exists to answer.
 *
 * Publishing itself stays in `staging.js`. This gates it.
 */

import { withTransaction } from '../../core/src/db/pool.js';
import { LedgerError } from '../../core/src/domain/ledger.js';
import {
  STATES, planTransition, availableTransitions, WorkflowError
} from '../../core/src/domain/workflow.js';
import { validateDraft } from './validate.js';
import { loadDraft } from './drafts.js';

/** The permissions a member holds, named as the domain expects them. */
export function permissionsOf(ctx) {
  const p = ctx?.permissions ?? {};
  return {
    search: !!p.search,
    fieldTransact: !!p.fieldTransact,
    adminBackorder: !!p.adminBackorder,
    ownerEdit: !!p.ownerEdit,
    planReview: !!p.planReview,
    assignNumber: !!p.assignNumber
  };
}

/** Lock the item and hand back what the chain needs to decide. */
async function lockItem(client, itemId, projectId) {
  const { rows } = await client.query(
    `SELECT i.*, b.archived AS batch_archived
       FROM import_items i
       JOIN import_batches b ON b.id = i.batch_id
      WHERE i.id = $1 AND i.project_id = $2
      FOR UPDATE OF i`,
    [itemId, projectId]
  );

  const item = rows[0];
  if (!item) throw new LedgerError('That FMR was not found.', 'NOT_FOUND');
  if (item.published_fmr_id) {
    throw new LedgerError('That FMR has already been published.', 'PUBLISHED');
  }
  if (item.archived || item.batch_archived) {
    throw new LedgerError('That draft is archived. Restore it first.', 'ARCHIVED');
  }
  return item;
}

async function audit(client, ctx, itemId, action, payload) {
  await client.query(
    `INSERT INTO audit_log
       (project_id, entity_type, entity_id, action, payload, user_id,
        user_email, source_interface)
     VALUES ($1,'DRAFT',$2,$3,$4,$5,$6,'REVIEW')`,
    [ctx.projectId, itemId, action, payload, ctx.user.id, ctx.user.email]
  );
}

/**
 * Move one FMR along the chain.
 *
 * Every move goes through here so that the permission check, the state check
 * and the audit row cannot be forgotten in one place and remembered in
 * another.
 */
export async function advance(ctx, { itemId, action, reason = null }) {
  return withTransaction(async (client) => {
    const item = await lockItem(client, itemId, ctx.projectId);
    const permissions = permissionsOf(ctx);

    let next;
    try {
      next = planTransition(action, {
        state: item.workflow_state, permissions, reason
      });
    } catch (error) {
      // The domain speaks the user's language already; keep the message and
      // let the API answer 422 rather than 500.
      if (error instanceof WorkflowError) {
        throw new LedgerError(error.message, error.code);
      }
      throw error;
    }

    // Sending for review is the moment the content stops being someone's
    // private notes, so it is checked here rather than at publish — a planner
    // should not spend their time finding a missing quantity.
    if (action === 'SUBMIT') {
      const { draft } = await loadDraft(client, itemId);
      const check = validateDraft(draft);
      const errors = check.issues.filter((i) => i.severity === 'error');
      if (errors.length) {
        throw new LedgerError(
          `Fix ${errors.length} problem${errors.length === 1 ? '' : 's'} before sending `
          + `this for review: ${errors[0].message}`,
          'HAS_ERRORS'
        );
      }
    }

    const sets = ['workflow_state = $2'];
    const values = [itemId, next];

    if (action === 'PLANNER_APPROVE' || action === 'PLANNER_RETURN') {
      sets.push('planner_decided_by = $3', 'planner_decided_at = now()',
        'planner_note = $4');
      values.push(ctx.user.id, reason);
    }

    await client.query(
      `UPDATE import_items SET ${sets.join(', ')} WHERE id = $1`, values
    );

    await audit(client, ctx, itemId, `WORKFLOW_${action}`, {
      from: item.workflow_state, to: next,
      fmrNumber: item.fmr_number, reason: reason ?? null
    });

    return { ok: true, itemId, from: item.workflow_state, state: next };
  });
}

/**
 * Give an FMR its official number, and release it.
 *
 * The number is the release identifier — what the field searches by and what
 * purchasing quotes against — so it belongs to whoever owns material control,
 * not to whoever happens to be editing the draft. Assigning it is its own
 * step for that reason.
 */
/**
 * The next FMR number for a project.
 *
 * The client's numbers count from 1 upward — 406, 407, 408 — and were typed by
 * hand in the spreadsheet this replaces, which is exactly the job a database
 * should be doing. The counter was seeded past the highest number that
 * migrated in, so an issued number cannot collide with the history.
 *
 * The UPDATE ... RETURNING takes a row lock, so two people releasing at the
 * same moment queue rather than both reading the same value. Skipping a number
 * when a transaction rolls back is deliberate: a gap is a smaller problem than
 * two FMRs claiming one number, and the unique index would refuse the second
 * anyway.
 */
async function nextFmrNumber(client, projectId) {
  const { rows } = await client.query(
    `UPDATE fmr_number_sequences
        SET next_value = next_value + 1, updated_at = now()
      WHERE project_id = $1
      RETURNING next_value - 1 AS issued`,
    [projectId]
  );

  // A project created before this existed, or one seeded outside the
  // migration. Start it above whatever numbers it already holds rather than
  // at 1, which would collide on the first release.
  if (!rows[0]) {
    await client.query(
      `INSERT INTO fmr_number_sequences (project_id, next_value)
       SELECT $1, coalesce(max(fmr_number::bigint), 0) + 1
         FROM fmr_headers
        WHERE project_id = $1 AND fmr_number ~ '^[0-9]+$'
       ON CONFLICT (project_id) DO NOTHING`,
      [projectId]
    );
    return nextFmrNumber(client, projectId);
  }

  return String(rows[0].issued);
}

export async function assignNumber(ctx, { itemId, fmrNumber }) {
  // Empty means "you decide", which is what the client asked for: the number
  // is the database's to issue. A number typed in still wins, because renumber
  // and correct-before-release are both real needs.
  const asked = String(fmrNumber ?? '').trim().toUpperCase();

  return withTransaction(async (client) => {
    const item = await lockItem(client, itemId, ctx.projectId);
    const permissions = permissionsOf(ctx);
    const number = asked || await nextFmrNumber(client, ctx.projectId);

    let next;
    try {
      next = planTransition('ASSIGN_NUMBER', {
        state: item.workflow_state, permissions
      });
    } catch (error) {
      if (error instanceof WorkflowError) {
        throw new LedgerError(error.message, error.code);
      }
      throw error;
    }

    // Already live under this number? Numbering it again would stage a second
    // requisition for material a crew may already be fetching.
    const { rows: live } = await client.query(
      `SELECT id FROM fmr_headers
        WHERE project_id = $1 AND upper(fmr_number) = upper($2)`,
      [ctx.projectId, number]
    );
    if (live[0]) {
      throw new LedgerError(
        `FMR ${number} already exists and is published. Give this one a different number.`,
        'NUMBER_IN_USE'
      );
    }

    try {
      await client.query(
        'UPDATE import_items SET fmr_number = $2, workflow_state = $3, '
        + 'numbered_by = $4, numbered_at = now() WHERE id = $1',
        [itemId, number, next, ctx.user.id]
      );
    } catch (error) {
      // one_active_draft_per_number
      if (error.code === '23505') {
        throw new LedgerError(
          `${number} already has a draft waiting. Publish or archive that one first, `
          + 'or give this one a different number.',
          'NUMBER_IN_USE'
        );
      }
      throw error;
    }

    await audit(client, ctx, itemId, 'WORKFLOW_ASSIGN_NUMBER', {
      from: item.workflow_state, to: next,
      was: item.fmr_number ?? null, now: number
    });

    return { ok: true, itemId, fmrNumber: number, state: next };
  });
}

/**
 * What is waiting on whoever is asking.
 *
 * One query for both queues: a planner's work and a material manager's are
 * the same question asked of different states.
 */
export async function reviewQueue(client, ctx, { state = null } = {}) {
  const permissions = permissionsOf(ctx);

  const mine = [];
  if (permissions.planReview) {
    mine.push(STATES.PENDING_PLANNER_REVIEW, STATES.PLANNER_APPROVED);
  }
  if (permissions.assignNumber) {
    mine.push(STATES.PENDING_MATERIAL_MANAGER, STATES.NUMBER_ASSIGNED);
  }
  if (permissions.ownerEdit) {
    mine.push(STATES.DRAFT, STATES.PLANNER_RETURNED);
  }

  if (!mine.length) return { items: [], states: [] };

  const wanted = state ? mine.filter((s) => s === state) : mine;
  if (!wanted.length) return { items: [], states: mine };

  const { rows } = await client.query(
    `SELECT i.id, i.fmr_number, i.iso_number, i.iso_sheet, i.line_count,
            i.workflow_state, i.planner_note, i.planner_decided_at,
            i.numbered_at, i.batch_id,
            b.source_name, b.created_at,
            pd.display_name AS planner_name,
            nb.display_name AS numbered_by_name
       FROM import_items i
       JOIN import_batches b ON b.id = i.batch_id
       LEFT JOIN users pd ON pd.id = i.planner_decided_by
       LEFT JOIN users nb ON nb.id = i.numbered_by
      WHERE i.project_id = $1
        AND i.workflow_state = ANY($2)
        AND i.published_fmr_id IS NULL
        AND NOT i.archived AND NOT b.archived
      ORDER BY b.created_at`,
    [ctx.projectId, wanted]
  );

  // The planner's job is to judge the request against the work package, which
  // cannot be done from a line count alone. Read-only here on purpose: this
  // screen is a decision, not an editor, and the planner has no draft access.
  // One query for the whole queue — a client cannot run queries in parallel.
  const { rows: lineRows } = rows.length
    ? await client.query(
        `SELECT item_id, line_number, commodity_code, size, description,
                quantity, uom
           FROM import_lines
          WHERE item_id = ANY($1::uuid[])
          ORDER BY item_id, line_number`,
        [rows.map((r) => r.id)]
      )
    : { rows: [] };

  const linesByItem = {};
  for (const line of lineRows) (linesByItem[line.item_id] ??= []).push({
    lineNumber: line.line_number,
    commodityCode: line.commodity_code,
    size: line.size,
    description: line.description,
    quantity: line.quantity,
    uom: line.uom
  });

  return {
    states: mine,
    items: rows.map((row) => ({
      id: row.id,
      batchId: row.batch_id,
      fmrNumber: row.fmr_number,
      isoNumber: row.iso_number,
      isoRevision: row.iso_revision,
      isoSheet: row.iso_sheet,
      lineCount: row.line_count,
      lines: linesByItem[row.id] ?? [],
      state: row.workflow_state,
      sourceName: row.source_name,
      createdAt: row.created_at,
      plannerNote: row.planner_note,
      plannerName: row.planner_name,
      plannerDecidedAt: row.planner_decided_at,
      numberedByName: row.numbered_by_name,
      numberedAt: row.numbered_at,
      actions: availableTransitions(row.workflow_state, permissions)
    }))
  };
}
