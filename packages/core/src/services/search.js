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
  if (!term) return { mode, results: [] };

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

  params.push(limit);

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

  const notices = await getFieldNotices(client, projectId, rows.map((r) => r.id));
  const bags = await activeBagsByLine(client, rows.map((r) => r.id));

  return {
    mode,
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
      notices: notices[row.id] ?? []
    }))
  };
}
