/**
 * Field notices, persisted.
 *
 * Raised when the office decides, settled as the crew works through them.
 * All functions take a client so they can join the caller's transaction — a
 * notice must appear in the same commit as the decision that caused it.
 */

import { describeNotice, planNoticeResolution, NOTICE_STATUS } from '../domain/notices.js';

/**
 * Raise or update the notice for a decision.
 *
 * One live notice per line, source request and kind, so deciding twice on the
 * same request updates the notice rather than stacking a second one on the
 * crew's card.
 */
export async function raiseNotice(client, { line, request, decision, quantity, uom,
                                            adminNotes, fullyDecided }) {
  const descriptor = describeNotice(decision, {
    quantity, uom, adminNotes, fullyDecided
  });
  if (!descriptor) return null;

  const { rows } = await client.query(
    `INSERT INTO field_notices
       (project_id, fmr_id, fmr_line_id, source_request_id, kind, severity,
        qty_notified, headline, detail, admin_notes, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Active')
     ON CONFLICT (fmr_line_id, coalesce(source_request_id,
                  '00000000-0000-0000-0000-000000000000'::uuid), kind)
       WHERE status = 'Active'
     DO UPDATE SET
       qty_notified = field_notices.qty_notified + EXCLUDED.qty_notified,
       severity     = EXCLUDED.severity,
       headline     = EXCLUDED.headline,
       detail       = EXCLUDED.detail,
       admin_notes  = EXCLUDED.admin_notes,
       updated_at   = now()
     RETURNING *`,
    [
      line.project_id, line.fmr_id, line.id, request?.id ?? null,
      descriptor.kind, descriptor.severity, descriptor.quantity,
      descriptor.headline, descriptor.detail, adminNotes ?? null
    ]
  );

  return rows[0];
}

/**
 * Settle outstanding notices against what the crew just did.
 *
 * Called from inside a field action's transaction, after the ledger has moved.
 */
export async function settleNotices(client, line, action, quantity) {
  const { rows: notices } = await client.query(
    `SELECT * FROM field_notices
      WHERE fmr_line_id = $1 AND status = 'Active'
      ORDER BY raised_at`,
    [line.id]
  );
  if (!notices.length) return { resolved: 0, steps: [] };

  const plan = planNoticeResolution(notices, action, quantity);

  for (const step of plan.steps) {
    await client.query(
      `UPDATE field_notices
          SET qty_resolved = $2,
              status = CASE WHEN $3 THEN 'Resolved' ELSE status END,
              resolved_at = CASE WHEN $3 THEN now() ELSE resolved_at END,
              resolved_reason = CASE WHEN $3 THEN $4 ELSE resolved_reason END,
              updated_at = now()
        WHERE id = $1`,
      [step.noticeId, step.qtyResolved, step.fullyResolved, `Settled by ${action}`]
    );
  }

  return plan;
}

/**
 * Close notices that no longer mean anything — the line is finished, or the
 * request behind them is gone. Keeps stale instructions off the crew's card.
 */
export async function sweepStaleNotices(client, lineId) {
  const { rowCount } = await client.query(
    `UPDATE field_notices n
        SET status = 'Superseded', resolved_at = now(),
            resolved_reason = 'No longer outstanding', updated_at = now()
       FROM fmr_lines l
      WHERE n.fmr_line_id = l.id
        AND l.id = $1
        AND n.status = 'Active'
        AND (l.qty_remaining_requirement <= 0
             OR NOT EXISTS (
               SELECT 1 FROM backorder_requests b
                WHERE b.id = n.source_request_id AND b.active
             ))`,
    [lineId]
  );
  return rowCount;
}

/** Live notices for a set of lines, keyed by line. */
export async function noticesForLines(client, projectId, lineIds) {
  if (!lineIds?.length) return {};

  const { rows } = await client.query(
    `SELECT * FROM field_notices
      WHERE project_id = $1 AND fmr_line_id = ANY($2::uuid[]) AND status = 'Active'
      ORDER BY raised_at DESC`,
    [projectId, lineIds]
  );

  const byLine = {};
  for (const row of rows) (byLine[row.fmr_line_id] ??= []).push(serializeNotice(row));
  return byLine;
}

/** Everything currently outstanding on a project, for the office to chase. */
export async function outstandingNotices(client, projectId) {
  const { rows } = await client.query(
    `SELECT n.*, l.iso_number, l.iso_sheet, l.line_number, l.material_description,
            l.commodity_code, l.size, h.fmr_number
       FROM field_notices n
       JOIN fmr_lines l   ON l.id = n.fmr_line_id
       JOIN fmr_headers h ON h.id = n.fmr_id
      WHERE n.project_id = $1 AND n.status = 'Active'
      ORDER BY n.severity DESC, n.raised_at`,
    [projectId]
  );

  return rows.map((row) => ({
    ...serializeNotice(row),
    fmrNumber: row.fmr_number,
    lineNumber: row.line_number,
    isoNumber: row.iso_number,
    isoSheet: row.iso_sheet,
    description: row.material_description,
    commodityCode: row.commodity_code,
    size: row.size
  }));
}

export function serializeNotice(row) {
  return {
    id: row.id,
    lineId: row.fmr_line_id,
    sourceRequestId: row.source_request_id,
    kind: row.kind,
    severity: row.severity,
    status: row.status,
    qtyNotified: Number(row.qty_notified),
    qtyResolved: Number(row.qty_resolved),
    qtyOutstanding: Number(row.qty_outstanding),
    headline: row.headline,
    detail: row.detail,
    adminNotes: row.admin_notes,
    raisedAt: row.raised_at,
    resolvedAt: row.resolved_at
  };
}

export { NOTICE_STATUS };
