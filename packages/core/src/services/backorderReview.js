/**
 * Admin review of backorder requests.
 *
 * The office decides what happens to material the field could not find:
 * confirm it will be supplied, reject it, or return it for more information.
 */

import { randomUUID } from 'node:crypto';
import { withTransaction } from '../db/pool.js';
import { LedgerError, lineState, lineStatus } from '../domain/ledger.js';
import { planAdminDecision, BACKORDER_STATUS } from '../domain/backorder.js';
import { serializeLine, HEADER_ROLLUP_SQL } from './field.js';
import { raiseNotice, noticesForLines } from './notices.js';

const QUEUE_PAGE = Object.freeze({ default: 25, min: 5, max: 200 });

/**
 * The queue the office works from, newest requests last.
 *
 * Paged. This returned every open request in one answer, which on the real
 * project was 412 rows and 300KB — a table nobody scrolls to the end of, sent
 * over site wifi to a phone. The page is decided in SQL for the same reason
 * the register's is: the count is a number the office needs regardless, and
 * the rows they can actually read are 25 of it.
 */
export async function getBackorderQueue(client, projectId, {
  status, page = 1, pageSize = QUEUE_PAGE.default
} = {}) {
  const size = Math.max(QUEUE_PAGE.min,
    Math.min(QUEUE_PAGE.max, Math.floor(Number(pageSize) || QUEUE_PAGE.default)));

  const { rows: [{ total }] } = await client.query(
    `SELECT count(*)::int AS total
       FROM backorder_requests b
      WHERE b.project_id = $1 AND b.active
        AND ($2::text IS NULL OR b.status = $2)`,
    [projectId, status ?? null]
  );

  const totalPages = Math.max(1, Math.ceil(total / size));
  const current = Math.max(1, Math.min(Math.floor(Number(page) || 1), totalPages));
  const offset = (current - 1) * size;

  const { rows } = await client.query(
    `SELECT b.*,
            l.iso_number, l.iso_sheet, l.commodity_code, l.size,
            l.material_description, l.uom, l.line_number,
            h.fmr_number, h.priority, h.date_required
       FROM backorder_requests b
       JOIN fmr_lines   l ON l.id = b.fmr_line_id
       JOIN fmr_headers h ON h.id = b.fmr_id
      WHERE b.project_id = $1
        AND b.active
        AND ($2::text IS NULL OR b.status = $2)
      ORDER BY h.fmr_number, l.line_number, b.reported_at
      LIMIT $3 OFFSET $4`,
    [projectId, status ?? null, size, offset]
  );

  return {
    requests: rows.map(serializeBackorder),
    pagination: {
      page: current,
      pageSize: size,
      totalRecords: total,
      totalPages,
      hasPrevious: current > 1,
      hasNext: current < totalPages,
      firstRecord: total ? offset + 1 : 0,
      lastRecord: Math.min(offset + size, total)
    }
  };
}

/**
 * Decide one request.
 *
 * Locks the request and its line together, in that order, so a field action
 * and an admin decision on the same line cannot interleave.
 */
export async function decideBackorder(ctx, req) {
  const { user, projectId } = ctx;
  const correlationId = randomUUID();
  const decision = String(req.decision || '').toUpperCase();

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM backorder_requests
        WHERE id = $1 AND project_id = $2 AND active
        FOR UPDATE`,
      [req.requestId, projectId]
    );

    const request = rows[0];
    if (!request) throw new LedgerError('Backorder request not found.', 'NOT_FOUND');

    const { rows: lineRows } = await client.query(
      `SELECT l.*, h.fmr_number
         FROM fmr_lines l
         JOIN fmr_headers h ON h.id = l.fmr_id
        WHERE l.id = $1
        FOR UPDATE OF l`,
      [request.fmr_line_id]
    );
    const line = lineRows[0];

    const plan = planAdminDecision(request, decision, req.quantity);

    // A returned request needs a reason the field crew can act on.
    if (decision === 'RETURN' && !req.notes) {
      throw new LedgerError(
        'Returning a request needs a note explaining what is required.',
        'MISSING_FIELD'
      );
    }

    await client.query(
      `UPDATE backorder_requests
          SET qty_confirmed = COALESCE($2, qty_confirmed),
              qty_pending   = $3,
              status        = $4,
              active        = COALESCE($5, active),
              admin_decision = $6,
              admin_notes    = $7,
              decided_by     = $8,
              decided_by_name = $9,
              decided_at     = now(),
              returned_review_reason = $10,
              updated_at     = now()
        WHERE id = $1`,
      [
        request.id,
        plan.update.qty_confirmed ?? null,
        plan.update.qty_pending,
        plan.update.status,
        plan.update.active ?? null,
        decision,
        req.notes ?? null,
        user.id,
        user.display_name,
        decision === 'RETURN' ? (req.notes ?? null) : null
      ]
    );

    // A partial return splits: the returned part becomes its own request,
    // linked back so the history stays traceable.
    let splitRequestId = null;
    if (plan.split) {
      const { rows: splitRows } = await client.query(
        `INSERT INTO backorder_requests
           (project_id, fmr_id, fmr_line_id, split_from_id, qty_requested, qty_pending,
            reason, field_notes, reported_by, reported_by_name, reported_at,
            status, returned_review_reason, correlation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING id`,
        [
          request.project_id, request.fmr_id, request.fmr_line_id, request.id,
          plan.split.qty_requested, plan.split.qty_pending, request.reason,
          request.field_notes, request.reported_by, request.reported_by_name,
          request.reported_at, BACKORDER_STATUS.RETURNED, req.notes ?? null, correlationId
        ]
      );
      splitRequestId = splitRows[0].id;
    }

    // Move the line's own backorder buckets to match the decision.
    const state = lineState(line);
    state.pendingBackorder = Math.max(0, state.pendingBackorder + plan.ledger.pendingDelta);
    state.confirmedBackorder = Math.max(0, state.confirmedBackorder + plan.ledger.confirmedDelta);

    await client.query(
      `UPDATE fmr_lines
          SET qty_pending_backorder = $2,
              qty_confirmed_backorder = $3,
              line_status = $4,
              updated_by = $5,
              updated_at = now()
        WHERE id = $1`,
      [line.id, state.pendingBackorder, state.confirmedBackorder, lineStatus(state), user.id]
    );

    // Tell the crew what was decided, on the line they raised it from.
    const notice = await raiseNotice(client, {
      line,
      request,
      decision,
      quantity: plan.quantity,
      uom: line.uom,
      adminNotes: req.notes,
      fullyDecided: plan.update.qty_pending === 0
    });

    await client.query(
      `INSERT INTO audit_log
         (project_id, entity_type, entity_id, action, payload, user_id, user_email,
          source_interface, correlation_id)
       VALUES ($1,'BACKORDER',$2,$3,$4,$5,$6,'ADMIN',$7)`,
      [
        projectId, request.id, `BACKORDER_${decision}`,
        {
          quantity: plan.quantity,
          notes: req.notes ?? null,
          splitRequestId,
          noticeId: notice?.id ?? null
        },
        user.id, user.email, correlationId
      ]
    );

    // Confirming or rejecting changes what the line is waiting on, which can
    // change how the FMR reads in the register.
    await client.query(HEADER_ROLLUP_SQL, [line.fmr_id, user.id]);

    const { rows: freshLine } = await client.query(
      `SELECT l.*, h.fmr_number FROM fmr_lines l
         JOIN fmr_headers h ON h.id = l.fmr_id
        WHERE l.id = $1`,
      [line.id]
    );

    return {
      ok: true,
      decision,
      correlationId,
      quantity: plan.quantity,
      splitRequestId,
      noticeRaised: notice ? { id: notice.id, headline: notice.headline } : null,
      line: serializeLine(freshLine[0])
    };
  });
}

/**
 * Notices the field crew needs to see.
 *
 * Kept as a re-export so callers have one place to ask; the notices service
 * owns the lifecycle.
 */
export const getFieldNotices = noticesForLines;

function serializeBackorder(row) {
  return {
    id: row.id,
    fmrId: row.fmr_id,
    fmrNumber: row.fmr_number,
    lineId: row.fmr_line_id,
    lineNumber: row.line_number,
    splitFromId: row.split_from_id,
    isoNumber: row.iso_number,
    isoSheet: row.iso_sheet,
    commodityCode: row.commodity_code,
    size: row.size,
    description: row.material_description,
    uom: row.uom,
    priority: row.priority,
    dateRequired: row.date_required,
    qtyRequested: Number(row.qty_requested),
    qtyConfirmed: Number(row.qty_confirmed),
    qtyPending: Number(row.qty_pending),
    reason: row.reason,
    fieldNotes: row.field_notes,
    reportedByName: row.reported_by_name,
    reportedAt: row.reported_at,
    status: row.status,
    adminDecision: row.admin_decision,
    adminNotes: row.admin_notes,
    decidedByName: row.decided_by_name,
    decidedAt: row.decided_at,
    returnedReviewReason: row.returned_review_reason
  };
}
