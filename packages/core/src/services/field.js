/**
 * Field actions.
 *
 * Each action runs in one transaction and takes a row lock on the line it
 * touches (SELECT ... FOR UPDATE). Two people working different lines never
 * block each other — the Apps Script version serialised the whole system
 * behind a single script lock.
 */

import { randomUUID } from 'node:crypto';
import { withTransaction } from '../db/pool.js';
import {
  ACTIONS, LedgerError, lineState, lineStatus, actionLimits,
  applyConfirmAvailable, applyBag, applyDirectIssue,
  applyIssueFromAvailable, applyIssueFromBag, applyBackorderRequest
} from '../domain/ledger.js';
import {
  planLocationTransitions, applyLocationTransitions,
  planReturnedResubmission, BACKORDER_STATUS
} from '../domain/backorder.js';
import { settleNotices, sweepStaleNotices } from './notices.js';
import { assertFieldOpen, nextBagTagNumber } from './controls.js';

/** Caps on the free-text fields a crew types, matching FMRv3. */
export const TEXT_LIMITS = Object.freeze({
  storageLocation: 100,
  notes: 500,
  issuedToName: 120,
  bagTagNumber: 40
});

function assertWithin(value, limit, label) {
  if (value != null && String(value).length > limit) {
    throw new LedgerError(
      `${label} is too long — keep it under ${limit} characters.`, 'TOO_LONG'
    );
  }
}

/**
 * Roll the header's status up from its lines, and stamp the activity time.
 *
 * The header carries no quantities of its own — the register sums them from
 * the lines, so there is nothing to keep in step. Status is the exception: it
 * is what someone scanning a list of FMRs reads, so it is derived here rather
 * than recomputed on every read.
 *
 * Takes ($1 fmrId, $2 userId).
 */
export const HEADER_ROLLUP_SQL = `
  UPDATE fmr_headers h
     SET last_activity_at = now(), updated_at = now(), updated_by = $2::uuid,
         current_status = rollup.status
    FROM (
      SELECT CASE
               WHEN coalesce(sum(qty_remaining_requirement), 0) <= 0
                 AND coalesce(sum(qty_requested), 0) > 0        THEN 'Complete'
               WHEN coalesce(sum(qty_issued), 0) > 0            THEN 'Partially Issued'
               WHEN coalesce(sum(qty_pending_backorder), 0)
                  + coalesce(sum(qty_confirmed_backorder), 0) > 0 THEN 'Backordered'
               WHEN coalesce(sum(qty_confirmed_located), 0) > 0  THEN 'In Progress'
               ELSE 'Open'
             END AS status
        FROM fmr_lines
       WHERE fmr_id = $1::uuid AND active
    ) rollup
   WHERE h.id = $1::uuid`;

/** Lock one line for update, scoped to the caller's project. */
async function lockLine(client, lineId, projectId) {
  const { rows } = await client.query(
    `SELECT l.*, h.fmr_number
       FROM fmr_lines l
       JOIN fmr_headers h ON h.id = l.fmr_id
      WHERE l.id = $1 AND l.project_id = $2
      FOR UPDATE OF l`,
    [lineId, projectId]
  );

  const line = rows[0];
  if (!line) throw new LedgerError('FMR line not found.', 'NOT_FOUND');
  if (!line.active) throw new LedgerError('This FMR line is inactive.', 'INACTIVE');
  return line;
}

async function persistState(client, line, state, userId) {
  await client.query(
    `UPDATE fmr_lines
        SET qty_confirmed_located   = $2,
            qty_active_bagged       = $3,
            qty_available           = $4,
            qty_issued              = $5,
            qty_pending_backorder   = $6,
            qty_confirmed_backorder = $7,
            line_status             = $8,
            updated_by              = $9,
            updated_at              = now()
      WHERE id = $1`,
    [
      line.id, state.confirmed, state.bagged, state.available, state.issued,
      state.pendingBackorder, state.confirmedBackorder, lineStatus(state), userId
    ]
  );
}

async function recordTransaction(client, line, type, quantity, user, details = {}) {
  await client.query(
    `INSERT INTO material_transactions
       (project_id, correlation_id, fmr_id, fmr_line_id, transaction_type, quantity,
        uom, performed_by, performed_by_name, issued_to_name, source_bag_tag_id,
        target_bag_tag_id, storage_location, backorder_request_id, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      line.project_id, details.correlationId, line.fmr_id, line.id, type, quantity,
      line.uom, user.id, details.performedByName ?? user.display_name,
      details.issuedToName ?? null, details.sourceBagTagId ?? null,
      details.targetBagTagId ?? null, details.storageLocation ?? null,
      details.backorderRequestId ?? null, details.notes ?? null
    ]
  );
}

async function recordAudit(client, line, action, user, correlationId, payload) {
  await client.query(
    `INSERT INTO audit_log
       (project_id, entity_type, entity_id, action, payload, user_id, user_email,
        source_interface, correlation_id)
     VALUES ($1,'FMR_LINE',$2,$3,$4,$5,$6,'FIELD',$7)`,
    [line.project_id, line.id, action, payload, user.id, user.email, correlationId]
  );
}

/**
 * Settle outstanding backorders against newly located material, then write
 * the resulting request rows back. Confirmed commitments go first, oldest
 * first; whatever is left reduces pending requests.
 */
async function settleBackorders(client, line, state, newlyLocated) {
  if (newlyLocated <= 0) return { confirmedConsumed: 0, pendingConsumed: 0 };

  const { rows: requests } = await client.query(
    `SELECT * FROM backorder_requests
      WHERE fmr_line_id = $1 AND active
      ORDER BY reported_at ASC`,
    [line.id]
  );

  const plan = planLocationTransitions(state, requests, newlyLocated);

  for (const step of plan.confirmedSteps) {
    await client.query(
      `UPDATE backorder_requests
          SET qty_confirmed = $2::numeric,
              status = CASE WHEN $2::numeric = 0 AND qty_pending = 0
                            THEN $3 ELSE status END,
              active = NOT ($2::numeric = 0 AND qty_pending = 0),
              updated_at = now()
        WHERE id = $1::uuid`,
      [step.requestId, step.remainingConfirmed, BACKORDER_STATUS.FULFILLED]
    );
  }

  for (const step of plan.pendingSteps) {
    await client.query(
      `UPDATE backorder_requests
          SET qty_pending = $2::numeric,
              status = CASE WHEN $2::numeric = 0 AND qty_confirmed = 0
                            THEN $3 ELSE status END,
              active = NOT ($2::numeric = 0 AND qty_confirmed = 0),
              updated_at = now()
        WHERE id = $1::uuid`,
      [step.requestId, step.remainingPending, BACKORDER_STATUS.FULFILLED]
    );
  }

  applyLocationTransitions(state, plan);
  return plan;
}

/** Draw material from one specific bag, locking that bag's item row. */
async function issueFromBag(client, line, state, req, user, correlationId) {
  const { rows } = await client.query(
    `SELECT i.*, t.tag_number
       FROM bag_tag_items i
       JOIN bag_tags t ON t.id = i.bag_tag_id
      WHERE i.bag_tag_id = $1 AND i.fmr_line_id = $2 AND i.status = 'Active'
      FOR UPDATE OF i`,
    [req.bagTagId, line.id]
  );

  const item = rows[0];
  if (!item) throw new LedgerError('That bag is not active for this line.', 'NOT_FOUND');

  const quantity = Number(req.quantity);
  applyIssueFromBag(state, quantity, item.qty_remaining_in_bag);

  const issuedFromBag = Number(item.qty_issued_from_bag) + quantity;
  const exhausted = issuedFromBag >= Number(item.qty_bagged);

  await client.query(
    `UPDATE bag_tag_items
        SET qty_issued_from_bag = $2,
            status = CASE WHEN $3 THEN 'Closed' ELSE status END,
            updated_at = now()
      WHERE id = $1`,
    [item.id, issuedFromBag, exhausted]
  );

  // Close the tag once nothing active remains under it.
  await client.query(
    `UPDATE bag_tags SET status = 'Closed', updated_at = now()
      WHERE id = $1
        AND NOT EXISTS (
          SELECT 1 FROM bag_tag_items WHERE bag_tag_id = $1 AND status = 'Active'
        )`,
    [item.bag_tag_id]
  );

  await recordTransaction(client, line, ACTIONS.ISSUE_FROM_BAG, quantity, user, {
    correlationId,
    performedByName: req.performedByName,
    issuedToName: req.issuedToName,
    sourceBagTagId: item.bag_tag_id,
    notes: req.notes
  });
}

/** Reserve material under a bag tag, creating the tag if this is its first line. */
async function reserveIntoBag(client, line, req, user, correlationId) {
  // A crew bagging into a pre-printed tag types that number; otherwise the
  // project's counter supplies one, as FMRv3 did. Either way nobody has to
  // invent a number that must not collide.
  const tagNumber = String(req.bagTagNumber || '').trim()
    || await nextBagTagNumber(client, line.project_id);

  const storageLocation = req.storageLocation || line.storage_location;

  const { rows: tagRows } = await client.query(
    `INSERT INTO bag_tags
       (project_id, tag_number, fmr_id, iso_key, storage_location,
        bagged_by, bagged_by_name, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'Active')
     ON CONFLICT (project_id, tag_number)
       DO UPDATE SET updated_at = now()
     RETURNING id, status`,
    [
      line.project_id, tagNumber, line.fmr_id, line.iso_key, storageLocation,
      user.id, req.performedByName ?? user.display_name
    ]
  );

  const tag = tagRows[0];
  if (tag.status !== 'Active') {
    throw new LedgerError(`Bag tag ${tagNumber} is already closed.`, 'BAG_CLOSED');
  }

  const quantity = Number(req.quantity);

  // One item row per line per bag: a second bagging of the same line adds to it.
  await client.query(
    `INSERT INTO bag_tag_items (bag_tag_id, fmr_line_id, qty_bagged, status)
     VALUES ($1,$2,$3,'Active')`,
    [tag.id, line.id, quantity]
  );

  await recordTransaction(client, line, ACTIONS.BAG, quantity, user, {
    correlationId,
    performedByName: req.performedByName,
    targetBagTagId: tag.id,
    storageLocation,
    notes: req.notes
  });

  return { bagTagId: tag.id, tagNumber };
}

/**
 * Raise a backorder.
 *
 * If the office previously returned a request for this line asking for more
 * information, this submission is the answer to it — so it revives that
 * request rather than opening a second one alongside it.
 */
async function raiseBackorder(client, line, req, user, correlationId) {
  const quantity = Number(req.quantity);

  const { rows: existing } = await client.query(
    `SELECT * FROM backorder_requests
      WHERE fmr_line_id = $1 AND active
      ORDER BY reported_at ASC`,
    [line.id]
  );

  const plan = planReturnedResubmission(existing, quantity);

  for (const step of plan.steps) {
    await client.query(
      `UPDATE backorder_requests
          SET status = $2,
              field_notes = coalesce($3, field_notes),
              reported_at = now(),
              returned_review_reason = NULL,
              admin_decision = NULL,
              updated_at = now()
        WHERE id = $1`,
      [
        step.requestId,
        step.revives ? BACKORDER_STATUS.PENDING : BACKORDER_STATUS.RETURNED,
        req.notes ?? null
      ]
    );
  }

  // Anything the returned requests did not absorb becomes a new request.
  if (plan.remainder <= 0) {
    return plan.steps[0]?.requestId ?? null;
  }

  const { rows } = await client.query(
    `INSERT INTO backorder_requests
       (project_id, fmr_id, fmr_line_id, qty_requested, qty_pending, reason,
        field_notes, reported_by, reported_by_name, status, correlation_id)
     VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [
      line.project_id, line.fmr_id, line.id, plan.remainder, req.reason,
      req.notes ?? null, user.id, req.performedByName ?? user.display_name,
      BACKORDER_STATUS.PENDING, correlationId
    ]
  );
  return rows[0].id;
}

/**
 * Perform one field action.
 *
 * @param {object} ctx { user, projectId }
 * @param {object} req { action, lineId, quantity, ... }
 */
export async function performFieldAction(ctx, req) {
  const { user, projectId } = ctx;
  const action = String(req.action || '').toUpperCase();
  const correlationId = randomUUID();

  // Free-text fields are typed on a phone in a warehouse. Cap them rather than
  // letting a stuck key fill a column.
  assertWithin(req.storageLocation, TEXT_LIMITS.storageLocation, 'Storage location');
  assertWithin(req.notes, TEXT_LIMITS.notes, 'Notes');
  assertWithin(req.issuedToName, TEXT_LIMITS.issuedToName, 'Issued-to name');
  assertWithin(req.bagTagNumber, TEXT_LIMITS.bagTagNumber, 'Bag tag number');

  return withTransaction(async (client) => {
    // Checked inside the transaction so a pause taken mid-action still holds.
    await assertFieldOpen(client, projectId);

    const line = await lockLine(client, req.lineId, projectId);
    const state = lineState(line);

    let newlyLocated = 0;
    let backorderRequestId = null;
    // The tag a bagging went into, so the crew can be told which number to
    // write on the bag when the server assigned it.
    let bagTagNumber = null;
    // BAG and ISSUE_FROM_BAG write their own transaction rows, since they
    // need the bag id that only becomes known inside those helpers.
    let transactionWritten = false;

    switch (action) {
      case ACTIONS.CONFIRM_AVAILABLE:
        if (!req.storageLocation) {
          throw new LedgerError('Storage location is required.', 'MISSING_FIELD');
        }
        applyConfirmAvailable(state, req.quantity);
        newlyLocated = Number(req.quantity);
        break;

      case ACTIONS.BAG:
        if (!req.storageLocation && !line.storage_location) {
          throw new LedgerError('Storage location is required.', 'MISSING_FIELD');
        }
        newlyLocated = applyBag(state, req.quantity);
        ({ tagNumber: bagTagNumber } = await reserveIntoBag(
          client, line, req, user, correlationId
        ));
        transactionWritten = true;
        break;

      case ACTIONS.DIRECT_ISSUE:
        if (!req.issuedToName) {
          throw new LedgerError('Issued-to name is required.', 'MISSING_FIELD');
        }
        applyDirectIssue(state, req.quantity);
        newlyLocated = Number(req.quantity);
        break;

      case ACTIONS.ISSUE_FROM_AVAILABLE:
        if (!req.issuedToName) {
          throw new LedgerError('Issued-to name is required.', 'MISSING_FIELD');
        }
        applyIssueFromAvailable(state, req.quantity);
        break;

      case ACTIONS.ISSUE_FROM_BAG:
        if (!req.issuedToName) {
          throw new LedgerError('Issued-to name is required.', 'MISSING_FIELD');
        }
        if (!req.bagTagId) throw new LedgerError('Bag tag is required.', 'MISSING_FIELD');
        await issueFromBag(client, line, state, req, user, correlationId);
        transactionWritten = true;
        break;

      case ACTIONS.BACKORDER_REQUESTED:
        if (!req.reason) throw new LedgerError('A backorder reason is required.', 'MISSING_FIELD');
        applyBackorderRequest(state, req.quantity);
        backorderRequestId = await raiseBackorder(client, line, req, user, correlationId);
        break;

      default:
        throw new LedgerError(`Unsupported field action: ${action}`, 'BAD_ACTION');
    }

    const settlement = await settleBackorders(client, line, state, newlyLocated);
    await persistState(client, line, state, user.id);

    // The crew was told to do something; doing it settles the notice.
    const notices = await settleNotices(client, line, action, Number(req.quantity));

    if (!transactionWritten) {
      await recordTransaction(client, line, action, Number(req.quantity), user, {
        correlationId,
        performedByName: req.performedByName,
        issuedToName: req.issuedToName,
        storageLocation: req.storageLocation,
        backorderRequestId,
        notes: req.notes
      });
    }

    await recordAudit(client, line, action, user, correlationId, {
      quantity: Number(req.quantity),
      backordersSettled: settlement.confirmedConsumed + settlement.pendingConsumed,
      noticesSettled: notices.resolved,
      ...(req.notes ? { notes: req.notes } : {})
    });

    await sweepStaleNotices(client, line.id);

    await client.query(
      HEADER_ROLLUP_SQL,
      [line.fmr_id, user.id]
    );

    const { rows } = await client.query('SELECT * FROM fmr_lines WHERE id = $1', [line.id]);
    const updated = rows[0];

    return {
      ok: true,
      action,
      correlationId,
      noticesSettled: notices.resolved,
      ...(bagTagNumber ? { bagTagNumber } : {}),
      line: serializeLine(updated),
      limits: actionLimits(lineState(updated))
    };
  });
}

export function serializeLine(line) {
  return {
    id: line.id,
    fmrId: line.fmr_id,
    fmrNumber: line.fmr_number,
    lineNumber: line.line_number,
    isoNumber: line.iso_number,
    isoSheet: line.iso_sheet,
    isoKey: line.iso_key,
    commodityCode: line.commodity_code,
    size: line.size,
    description: line.material_description,
    uom: line.uom,
    storageLocation: line.storage_location,
    status: line.line_status,
    quantities: {
      requested: Number(line.qty_requested),
      located: Number(line.qty_confirmed_located),
      bagged: Number(line.qty_active_bagged),
      available: Number(line.qty_available),
      issued: Number(line.qty_issued),
      pendingBackorder: Number(line.qty_pending_backorder),
      confirmedBackorder: Number(line.qty_confirmed_backorder),
      notYetLocated: Number(line.qty_not_yet_located),
      remaining: Number(line.qty_remaining_requirement)
    }
  };
}
