/**
 * Search.
 *
 * FMRv3 maintained a Search_Index sheet by hand because Sheets could not scan.
 * Postgres indexes replace it entirely — this file is the whole of what that
 * machinery did.
 *
 * Crews search two ways: by FMR number, or by ISO drawing. ISO entry is messy
 * in the field, so "D-1234-05" is understood as drawing D-1234, sheet 05 —
 * the same suffix handling PublicApi.gs did.
 */

import { serializeLine } from './field.js';
import { getFieldNotices } from './backorderReview.js';
import { clean, isoCandidates } from '../domain/isoKey.js';

export { isoCandidates };

export async function searchLines(client, projectId, { query, mode = 'AUTO', limit = 200 }) {
  const term = clean(query);
  if (!term) return { mode, truncated: false, limit, results: [] };

  const wantsFmr = mode === 'AUTO' || mode === 'FMR';
  const wantsIso = mode === 'AUTO' || mode === 'ISO';

  const conditions = [];
  const params = [projectId];

  if (wantsFmr) {
    params.push(`${term}%`);
    conditions.push(`upper(h.fmr_number) LIKE $${params.length}`);
  }

  if (wantsIso) {
    const candidates = isoCandidates(term);
    params.push(candidates);
    conditions.push(`l.iso_key = ANY($${params.length}::text[])`);

    // Also match on the drawing number alone, so a crew can pull up every
    // sheet of a drawing at once.
    params.push(`${term}%`);
    conditions.push(`upper(l.iso_number) LIKE $${params.length}`);
  }

  // One more than asked for, so the caller can tell a full page from a page
  // that happens to end on the limit. A short prefix matches a great deal —
  // "4" is 1,388 lines on the real project — and a crew shown 200 of them with
  // no sign of the rest reads it as the whole answer.
  params.push(limit + 1);

  const { rows } = await client.query(
    `SELECT l.*, h.fmr_number, h.priority, h.date_required
       FROM fmr_lines l
       JOIN fmr_headers h ON h.id = l.fmr_id
      WHERE l.project_id = $1
        AND l.active
        AND (${conditions.join(' OR ')})
      ORDER BY h.fmr_number, l.line_number
      LIMIT $${params.length}`,
    params
  );

  const truncated = rows.length > limit;
  if (truncated) rows.length = limit;

  const notices = await getFieldNotices(client, projectId, rows.map((r) => r.id));
  const bags = await activeBagsByLine(client, rows.map((r) => r.id));

  return {
    mode,
    truncated,
    limit,
    results: rows.map((row) => ({
      ...serializeLine(row),
      priority: row.priority,
      dateRequired: row.date_required,
      activeBags: bags[row.id] ?? [],
      notices: notices[row.id] ?? []
    }))
  };
}

/** Which bags currently hold material for these lines. */
export async function activeBagsByLine(client, lineIds) {
  if (!lineIds?.length) return {};

  const { rows } = await client.query(
    `SELECT i.fmr_line_id, i.id AS item_id, i.qty_bagged, i.qty_remaining_in_bag,
            t.id AS bag_tag_id, t.tag_number, t.storage_location, t.bagged_at
       FROM bag_tag_items i
       JOIN bag_tags t ON t.id = i.bag_tag_id
      WHERE i.fmr_line_id = ANY($1::uuid[])
        AND i.status = 'Active'
        AND i.qty_remaining_in_bag > 0
      ORDER BY t.bagged_at`,
    [lineIds]
  );

  const byLine = {};
  for (const row of rows) {
    (byLine[row.fmr_line_id] ??= []).push({
      bagTagId: row.bag_tag_id,
      tagNumber: row.tag_number,
      storageLocation: row.storage_location,
      qtyBagged: Number(row.qty_bagged),
      qtyRemaining: Number(row.qty_remaining_in_bag),
      baggedAt: row.bagged_at
    });
  }
  return byLine;
}

/**
 * The notes a crew left on these lines, newest first.
 *
 * FMRv3 built this in AdminFieldNotesService.gs:432 and it is the reason the
 * drill-down was worth opening: the office sees "rack 12 empty, checked 14
 * too" beside the quantity, rather than a number with no account of itself.
 * Two sources are merged, exactly as the old system did — what the crew typed
 * on a transaction, and the note they wrote when raising a backorder.
 *
 * Capped per line, with a flag when there is more, so one line that a crew
 * annotated forty times cannot bury the rest of the FMR.
 */
const MAX_NOTES_PER_LINE = 20;

/**
 * Only the five movement actions are read from the transaction log.
 *
 * BACKORDER_REQUESTED is deliberately absent: raising a backorder writes the
 * crew's note to both the transaction and the request, so counting both would
 * show the office the same sentence twice. FMRv3 drew the same line
 * (AdminFieldNotesService.gs:6 FIELD_TRANSACTION_TYPES) — the backorder note
 * comes from the request below, which also carries the quantity asked for.
 */
const NOTED_TRANSACTION_TYPES = Object.freeze([
  'CONFIRM_AVAILABLE', 'BAG', 'DIRECT_ISSUE',
  'ISSUE_FROM_AVAILABLE', 'ISSUE_FROM_BAG'
]);

const ACTION_LABELS = Object.freeze({
  CONFIRM_AVAILABLE: 'Confirm Available',
  BAG: 'Bag & Tag',
  DIRECT_ISSUE: 'Locate & Issue',
  ISSUE_FROM_AVAILABLE: 'Issue Available',
  ISSUE_FROM_BAG: 'Issue From Bag',
  BACKORDER_REQUESTED: 'Backorder Request'
});

export async function fieldNotesByLine(client, projectId, lineIds) {
  const byLine = {};
  if (!lineIds.length) return byLine;

  // A note the crew typed while moving material.
  const { rows: transactions } = await client.query(
    `SELECT t.id, t.fmr_line_id, t.transaction_type, t.quantity, t.uom,
            t.performed_by_name, t.issued_to_name, t.storage_location,
            t.notes, t.created_at, u.display_name AS user_name
       FROM material_transactions t
       LEFT JOIN users u ON u.id = t.performed_by
      WHERE t.project_id = $1
        AND t.fmr_line_id = ANY($2::uuid[])
        AND t.transaction_type = ANY($3::text[])
        AND t.notes IS NOT NULL
        AND btrim(t.notes) <> ''`,
    [projectId, lineIds, NOTED_TRANSACTION_TYPES]
  );

  // A note the crew wrote when asking the office for material.
  const { rows: backorders } = await client.query(
    `SELECT b.id, b.fmr_line_id, b.qty_requested, b.field_notes,
            b.reported_by_name, b.reported_at, l.uom
       FROM backorder_requests b
       JOIN fmr_lines l ON l.id = b.fmr_line_id
      WHERE b.project_id = $1
        AND b.fmr_line_id = ANY($2::uuid[])
        AND b.field_notes IS NOT NULL
        AND btrim(b.field_notes) <> ''`,
    [projectId, lineIds]
  );

  const push = (lineId, note) => {
    (byLine[lineId] ??= []).push(note);
  };

  for (const row of transactions) {
    push(row.fmr_line_id, {
      id: String(row.id),
      source: 'TRANSACTION',
      action: row.transaction_type,
      actionLabel: ACTION_LABELS[row.transaction_type] ?? row.transaction_type,
      quantity: Number(row.quantity),
      uom: row.uom,
      performedBy: row.performed_by_name ?? row.user_name,
      issuedTo: row.issued_to_name,
      storageLocation: row.storage_location,
      notes: row.notes,
      at: row.created_at
    });
  }

  for (const row of backorders) {
    push(row.fmr_line_id, {
      id: String(row.id),
      source: 'BACKORDER_REQUEST',
      action: 'BACKORDER_REQUESTED',
      actionLabel: ACTION_LABELS.BACKORDER_REQUESTED,
      quantity: Number(row.qty_requested),
      uom: row.uom,
      performedBy: row.reported_by_name,
      issuedTo: null,
      storageLocation: null,
      notes: row.field_notes,
      at: row.reported_at
    });
  }

  for (const [lineId, notes] of Object.entries(byLine)) {
    notes.sort((a, b) => new Date(b.at) - new Date(a.at));
    byLine[lineId] = {
      count: notes.length,
      truncated: notes.length > MAX_NOTES_PER_LINE,
      notes: notes.slice(0, MAX_NOTES_PER_LINE)
    };
  }

  return byLine;
}

/** One FMR with all its lines — the drill-down from a search result. */
export async function getFmrDetail(client, projectId, fmrId) {
  const { rows: headers } = await client.query(
    `SELECT * FROM fmr_headers WHERE id = $1 AND project_id = $2`,
    [fmrId, projectId]
  );
  if (!headers[0]) return null;

  const { rows: lines } = await client.query(
    `SELECT l.*, h.fmr_number FROM fmr_lines l
       JOIN fmr_headers h ON h.id = l.fmr_id
      WHERE l.fmr_id = $1 AND l.active
      ORDER BY l.line_number`,
    [fmrId]
  );

  const lineIds = lines.map((l) => l.id);
  const notices = await getFieldNotices(client, projectId, lineIds);
  const bags = await activeBagsByLine(client, lineIds);
  const fieldNotes = await fieldNotesByLine(client, projectId, lineIds);

  const header = headers[0];
  const totals = lines.reduce(
    (acc, l) => ({
      requested: acc.requested + Number(l.qty_requested),
      issued: acc.issued + Number(l.qty_issued),
      remaining: acc.remaining + Number(l.qty_remaining_requirement)
    }),
    { requested: 0, issued: 0, remaining: 0 }
  );

  return {
    id: header.id,
    fmrNumber: header.fmr_number,
    iwpNumber: header.iwp_number,
    requestedBy: header.requested_by,
    dateRequired: header.date_required,
    priority: header.priority,
    status: header.current_status,
    notes: header.notes,
    totals: {
      ...totals,
      fulfillmentPct: totals.requested > 0
        ? Math.round((totals.issued / totals.requested) * 100)
        : 0
    },
    lines: lines.map((row) => ({
      ...serializeLine(row),
      activeBags: bags[row.id] ?? [],
      notices: notices[row.id] ?? [],
      fieldNotes: fieldNotes[row.id] ?? { count: 0, truncated: false, notes: [] }
    }))
  };
}
