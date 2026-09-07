/**
 * Office reporting.
 *
 * Two roll-ups the office works from: every FMR with its progress, and the
 * same material grouped by drawing. In FMRv3 these were assembled row by row
 * in Apps Script; here they are single aggregate queries.
 */

import { isoCandidates } from '../domain/isoKey.js';

/**
 * How the register may be narrowed.
 *
 * Ported from FMRv3 (`AdminRegisterService.gs:102`). An FMR register with 660
 * live FMRs and no way to narrow it is a list nobody reads, so these are not
 * decoration — they are how an expeditor finds the work that needs them.
 */
export const REGISTER_QUERY_TYPES = Object.freeze(['AUTO', 'FMR', 'ISO', 'IWP']);

/**
 * The exception filters, as SQL over the line aggregates.
 *
 * Each answers a question somebody actually asks: what is still outstanding,
 * what has not been fully found, what is sitting on the shelf, what is bagged
 * and waiting, what is stuck behind the office. Mirrors
 * `matchesAdminRegisterExceptionFmrV3_`.
 */
const EXCEPTIONS = Object.freeze({
  ALL: null,
  HAS_REMAINING: 'coalesce(sum(l.qty_remaining_requirement), 0) > 0',
  NOT_FULLY_LOCATED: 'coalesce(sum(l.qty_confirmed_located), 0) < coalesce(sum(l.qty_requested), 0)',
  HAS_AVAILABLE: 'coalesce(sum(l.qty_available), 0) > 0',
  HAS_BAGGED: 'coalesce(sum(l.qty_active_bagged), 0) > 0',
  PENDING_BACKORDER: 'coalesce(sum(l.qty_pending_backorder), 0) > 0',
  CONFIRMED_BACKORDER: 'coalesce(sum(l.qty_confirmed_backorder), 0) > 0'
});

/**
 * Sort keys, as SQL. Fixed strings chosen by name — never interpolated from
 * the request, so a sort parameter cannot reach the query.
 */
const SORTS = Object.freeze({
  LAST_ACTIVITY: 'h.last_activity_at',
  DATE_REQUIRED: 'h.date_required',
  FMR_NUMBER: 'h.fmr_number',
  REMAINING: 'coalesce(sum(l.qty_remaining_requirement), 0)',
  FULFILLMENT: `CASE WHEN coalesce(sum(l.qty_requested), 0) > 0
                     THEN coalesce(sum(l.qty_issued), 0)
                          / nullif(sum(l.qty_requested), 0)
                     ELSE 0 END`,
  REQUESTED: 'coalesce(sum(l.qty_requested), 0)'
});

export const REGISTER_EXCEPTIONS = Object.freeze(Object.keys(EXCEPTIONS));
export const REGISTER_SORTS = Object.freeze(Object.keys(SORTS));

const PAGE_SIZE = { min: 10, max: 100, default: 25 };

/** Clamp a page size the way FMRv3 did, so a hand-typed URL cannot ask for everything. */
const clampPageSize = (value) => {
  const asked = Math.floor(Number(value) || PAGE_SIZE.default);
  return Math.max(PAGE_SIZE.min, Math.min(PAGE_SIZE.max, asked));
};

/**
 * The FMR register.
 *
 * Search, filter, sort and page, all decided in SQL — the register is the one
 * screen that grows without limit, and pulling 660 FMRs into memory to sort
 * them in JavaScript would be the wrong shape from the first day.
 *
 * `query` is matched by `queryType`:
 *   FMR   the FMR number
 *   ISO   a drawing, through the same `isoCandidates` expansion the field
 *         search uses, so "D-4410-01" finds sheet 01
 *   IWP   the work package
 *   AUTO  any of the above, plus who requested it and the header notes
 */
export async function getRegister(client, projectId, {
  status, priority, query, queryType = 'AUTO',
  exception = 'ALL', sort = 'LAST_ACTIVITY', direction = 'DESC',
  page = 1, pageSize = PAGE_SIZE.default
} = {}) {
  const term = String(query ?? '').trim();
  const type = REGISTER_QUERY_TYPES.includes(String(queryType).toUpperCase())
    ? String(queryType).toUpperCase() : 'AUTO';
  const exceptionKey = exception && exception in EXCEPTIONS ? exception : 'ALL';
  const sortKey = sort && sort in SORTS ? sort : 'LAST_ACTIVITY';
  const descending = String(direction).toUpperCase() !== 'ASC';
  const size = clampPageSize(pageSize);

  // $1 project, $2 status, $3 priority, then whatever the search needs.
  const params = [projectId, status ?? null, priority ?? null];
  const where = [
    'h.project_id = $1',
    'h.active',
    '($2::text IS NULL OR h.current_status = $2)',
    '($3::text IS NULL OR h.priority = $3)'
  ];

  if (term) {
    const like = `%${term}%`;
    const matches = [];

    if (type === 'FMR' || type === 'AUTO') {
      params.push(`${term}%`);
      matches.push(`h.fmr_number ILIKE $${params.length}`);
    }

    if (type === 'IWP' || type === 'AUTO') {
      params.push(like);
      matches.push(`h.iwp_number ILIKE $${params.length}`);
    }

    if (type === 'ISO' || type === 'AUTO') {
      // The same expansion the field search uses, so a register search for
      // "D-4410-01" finds sheet 01 rather than nothing.
      params.push(isoCandidates(term));
      const candidates = params.length;
      params.push(`${term}%`);
      const bare = params.length;
      matches.push(
        `EXISTS (SELECT 1 FROM fmr_lines x
                  WHERE x.fmr_id = h.id AND x.active
                    AND (x.iso_key = ANY($${candidates}::text[])
                         OR upper(x.iso_number) LIKE upper($${bare})))`
      );
    }

    if (type === 'AUTO') {
      // Whoever asked for it, and anything written on the header.
      params.push(like);
      matches.push(`h.requested_by ILIKE $${params.length}`);
      params.push(like);
      matches.push(`h.notes ILIKE $${params.length}`);
    }

    where.push(`(${matches.join(' OR ')})`);
  }

  const having = EXCEPTIONS[exceptionKey];
  const order = `${SORTS[sortKey]} ${descending ? 'DESC' : 'ASC'} NULLS LAST, h.fmr_number`;

  const body = `
       FROM fmr_headers h
       LEFT JOIN fmr_lines l ON l.fmr_id = h.id AND l.active
      WHERE ${where.join('\n        AND ')}
      GROUP BY h.id
      ${having ? `HAVING ${having}` : ''}`;

  // How many match, before paging — the count a person needs to know whether
  // to narrow further.
  const { rows: counted } = await client.query(
    `SELECT count(*) AS n FROM (SELECT h.id ${body}) AS matched`,
    params
  );
  const totalRecords = Number(counted[0].n);
  const totalPages = Math.max(1, Math.ceil(totalRecords / size));
  const current = Math.min(Math.max(Math.floor(Number(page) || 1), 1), totalPages);
  const offset = (current - 1) * size;

  params.push(size, offset);

  const { rows } = await client.query(
    `SELECT h.id, h.fmr_number, h.iwp_number, h.requested_by, h.date_required,
            h.priority, h.current_status, h.last_activity_at,
            count(l.id)                              AS line_count,
            coalesce(sum(l.qty_requested), 0)        AS qty_requested,
            coalesce(sum(l.qty_issued), 0)           AS qty_issued,
            coalesce(sum(l.qty_available), 0)        AS qty_available,
            coalesce(sum(l.qty_active_bagged), 0)    AS qty_bagged,
            coalesce(sum(l.qty_remaining_requirement), 0) AS qty_remaining,
            coalesce(sum(l.qty_pending_backorder
                       + l.qty_confirmed_backorder), 0)   AS qty_backordered
       ${body}
      ORDER BY ${order}
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  const fmrs = rows.map((row) => ({
    id: row.id,
    fmrNumber: row.fmr_number,
    iwpNumber: row.iwp_number,
    requestedBy: row.requested_by,
    dateRequired: row.date_required,
    priority: row.priority,
    status: row.current_status,
    lastActivityAt: row.last_activity_at,
    lineCount: Number(row.line_count),
    qtyRequested: Number(row.qty_requested),
    qtyIssued: Number(row.qty_issued),
    qtyAvailable: Number(row.qty_available),
    qtyBagged: Number(row.qty_bagged),
    qtyRemaining: Number(row.qty_remaining),
    qtyBackordered: Number(row.qty_backordered),
    fulfillmentPct: pct(row.qty_issued, row.qty_requested)
  }));

  // Totals describe everything the filters matched, not just this page —
  // otherwise turning the page appears to change how much work is outstanding.
  const { rows: summed } = await client.query(
    `SELECT coalesce(sum(t.line_count), 0)  AS lines,
            coalesce(sum(t.requested), 0)   AS requested,
            coalesce(sum(t.issued), 0)      AS issued,
            coalesce(sum(t.backordered), 0) AS backordered
       FROM (SELECT count(l.id) AS line_count,
                    coalesce(sum(l.qty_requested), 0) AS requested,
                    coalesce(sum(l.qty_issued), 0)    AS issued,
                    coalesce(sum(l.qty_pending_backorder
                               + l.qty_confirmed_backorder), 0) AS backordered
             ${body}) AS t`,
    params.slice(0, params.length - 2)
  );

  const totals = {
    lines: Number(summed[0].lines),
    requested: Number(summed[0].requested),
    issued: Number(summed[0].issued),
    backordered: Number(summed[0].backordered)
  };

  // The choices to offer, drawn from what this project actually has, so the
  // filter never lists a status or priority with nothing behind it.
  const { rows: options } = await client.query(
    `SELECT array_agg(DISTINCT current_status) FILTER (WHERE current_status IS NOT NULL)
              AS statuses,
            array_agg(DISTINCT priority) FILTER (WHERE priority IS NOT NULL)
              AS priorities
       FROM fmr_headers WHERE project_id = $1 AND active`,
    [projectId]
  );

  return {
    fmrs,
    filters: {
      statuses: (options[0].statuses ?? []).sort(),
      priorities: (options[0].priorities ?? []).sort(),
      queryTypes: REGISTER_QUERY_TYPES,
      exceptions: REGISTER_EXCEPTIONS,
      sorts: REGISTER_SORTS
    },
    applied: {
      status: status ?? null, priority: priority ?? null,
      query: term || null, queryType: type,
      exception: exceptionKey, sort: sortKey,
      direction: descending ? 'DESC' : 'ASC'
    },
    pagination: {
      page: current,
      pageSize: size,
      totalRecords,
      totalPages,
      hasPrevious: current > 1,
      hasNext: current < totalPages,
      firstRecord: totalRecords ? offset + 1 : 0,
      lastRecord: Math.min(offset + size, totalRecords)
    },
    totals: { ...totals, fulfillmentPct: pct(totals.issued, totals.requested) }
  };
}

/**
 * The same material grouped by drawing sheet.
 *
 * A drawing is what a crew is actually building from, and its material often
 * spans several FMRs — so this is the view that answers "can we start this
 * spool yet".
 */
export async function getIsoSummary(client, projectId, {
  query, page = 1, pageSize = 25
} = {}) {
  const size = Math.max(5, Math.min(200, Math.floor(Number(pageSize) || 25)));
  const term = String(query ?? '').trim();

  // A drawing number typed as it appears on the sheet. The same expansion the
  // field search uses, so "LP131-AI(100)-850211-1" finds sheet 1 rather than
  // nothing — the suffix is how people write these down.
  const params = [projectId];
  let match = '';
  if (term) {
    const candidates = isoCandidates(term);
    params.push(`%${term.toLowerCase()}%`, candidates);
    match = ` AND (lower(l.iso_number) LIKE $2 OR l.iso_key = ANY($3::text[]))`;
  }

  const { rows: [{ total }] } = await client.query(
    `SELECT count(*)::int AS total FROM (
       SELECT 1 FROM fmr_lines l
        WHERE l.project_id = $1 AND l.active${match}
        GROUP BY l.iso_number, l.iso_sheet) AS drawings`,
    params
  );

  const totalPages = Math.max(1, Math.ceil(total / size));
  const current = Math.max(1, Math.min(Math.floor(Number(page) || 1), totalPages));
  const offset = (current - 1) * size;

  const { rows } = await client.query(
    `SELECT l.iso_number, l.iso_sheet,
            count(*)                                  AS line_count,
            count(DISTINCT l.fmr_id)                  AS fmr_count,
            coalesce(sum(l.qty_requested), 0)         AS qty_requested,
            coalesce(sum(l.qty_issued), 0)            AS qty_issued,
            coalesce(sum(l.qty_available), 0)         AS qty_available,
            coalesce(sum(l.qty_active_bagged), 0)     AS qty_bagged,
            coalesce(sum(l.qty_pending_backorder
                       + l.qty_confirmed_backorder), 0) AS qty_backordered
       FROM fmr_lines l
      WHERE l.project_id = $1 AND l.active${match}
      GROUP BY l.iso_number, l.iso_sheet
      ORDER BY l.iso_number, l.iso_sheet
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, size, offset]
  );

  return {
    drawings: rows.map((row) => ({
      isoNumber: row.iso_number,
      isoRevision: row.iso_revision,
      isoSheet: row.iso_sheet,
      lineCount: Number(row.line_count),
      fmrCount: Number(row.fmr_count),
      qtyRequested: Number(row.qty_requested),
      qtyIssued: Number(row.qty_issued),
      qtyAvailable: Number(row.qty_available),
      qtyBagged: Number(row.qty_bagged),
      qtyBackordered: Number(row.qty_backordered),
      fulfillmentPct: pct(row.qty_issued, row.qty_requested)
    })),
    pagination: {
      page: current,
      pageSize: size,
      totalRecords: total,
      totalPages,
      hasPrevious: current > 1,
      hasNext: current < totalPages,
      firstRecord: total ? offset + 1 : 0,
      lastRecord: Math.min(offset + size, total)
    },
    applied: { query: term || null }
  };
}

/** Everything that happened to one line, newest first. */
export async function getLineHistory(client, projectId, lineId) {
  const { rows } = await client.query(
    `SELECT t.*, u.display_name AS user_name
       FROM material_transactions t
       LEFT JOIN users u ON u.id = t.performed_by
      WHERE t.project_id = $1 AND t.fmr_line_id = $2
      ORDER BY t.created_at DESC`,
    [projectId, lineId]
  );

  return rows.map((row) => ({
    id: String(row.id),
    type: row.transaction_type,
    quantity: Number(row.quantity),
    uom: row.uom,
    performedBy: row.performed_by_name ?? row.user_name,
    issuedTo: row.issued_to_name,
    storageLocation: row.storage_location,
    notes: row.notes,
    correlationId: row.correlation_id,
    at: row.created_at
  }));
}

/**
 * Bags with material still in them, oldest first.
 *
 * FMRv3 showed this beside the backorder queue (AdminActiveBagService.gs:7)
 * and the reason is the same here: a bag that was packed and never issued is
 * material the office believes is gone and the field cannot use. The count on
 * the dashboard says how many; this says which, so somebody can go and find
 * them.
 *
 * Oldest first by default because age is the whole signal — a bag packed this
 * morning is work in progress, one packed three weeks ago is a problem.
 *
 * `readiness` separates a bag nobody has touched from one a crew has drawn
 * against and left part-full; `staleAfterDays` marks the ones old enough to
 * chase.
 */
const STALE_AFTER_DAYS = 14;

export async function getActiveBagQueue(client, projectId, {
  query, readiness = 'ALL', sortOrder = 'OLDEST_FIRST',
  page = 1, pageSize = 25, staleAfterDays = STALE_AFTER_DAYS
} = {}) {
  const term = String(query ?? '').trim();
  const wanted = String(readiness || 'ALL').toUpperCase();
  const newestFirst = String(sortOrder || '').toUpperCase() === 'NEWEST_FIRST';
  const size = Math.min(Math.max(Number(pageSize) || 25, 1), 200);

  const { rows } = await client.query(
    `SELECT t.id                AS bag_tag_id,
            i.id                AS bag_tag_item_id,
            t.tag_number, t.fmr_id, t.iso_key, t.storage_location,
            t.bagged_by_name, t.bagged_at, t.notes, t.status,
            h.fmr_number, h.priority, h.date_required,
            l.id                AS fmr_line_id,
            l.line_number, l.iso_number, l.iso_sheet, l.commodity_code,
            l.size, l.material_description, l.uom,
            i.qty_bagged, i.qty_issued_from_bag, i.qty_remaining_in_bag,
            (now() - t.bagged_at) >= make_interval(days => $3::int) AS stale
       FROM bag_tag_items i
       JOIN bag_tags     t ON t.id = i.bag_tag_id
       JOIN fmr_lines    l ON l.id = i.fmr_line_id
       JOIN fmr_headers  h ON h.id = t.fmr_id
      WHERE t.project_id = $1
        AND i.status = 'Active'
        AND i.qty_remaining_in_bag > 0
        AND ($2::text IS NULL OR (
              t.tag_number          ILIKE '%' || $2 || '%' OR
              h.fmr_number          ILIKE '%' || $2 || '%' OR
              l.iso_key             ILIKE '%' || $2 || '%' OR
              l.commodity_code      ILIKE '%' || $2 || '%' OR
              l.material_description ILIKE '%' || $2 || '%' OR
              t.storage_location    ILIKE '%' || $2 || '%'))
      ORDER BY t.bagged_at ASC, t.tag_number ASC`,
    [projectId, term || null, staleAfterDays]
  );

  const all = rows.map((row) => {
    const issued = Number(row.qty_issued_from_bag);
    const ready = issued > 0 ? 'PARTIALLY_ISSUED' : 'READY_FOR_FIELD';

    return {
      bagTagId: row.bag_tag_id,
      bagTagItemId: row.bag_tag_item_id,
      tagNumber: row.tag_number,
      fmrId: row.fmr_id,
      fmrNumber: row.fmr_number,
      fmrLineId: row.fmr_line_id,
      lineNumber: row.line_number,
      isoKey: row.iso_key ?? `${row.iso_number}|${row.iso_sheet}`,
      commodityCode: row.commodity_code,
      size: row.size,
      description: row.material_description,
      uom: row.uom,
      storageLocation: row.storage_location,
      qtyBagged: Number(row.qty_bagged),
      qtyIssued: issued,
      qtyRemaining: Number(row.qty_remaining_in_bag),
      status: row.status,
      readiness: ready,
      readinessLabel: ready === 'READY_FOR_FIELD' ? 'Ready for Field' : 'Partially Issued',
      stale: row.stale,
      baggedBy: row.bagged_by_name,
      baggedAt: row.bagged_at,
      priority: row.priority,
      dateRequired: row.date_required,
      notes: row.notes
    };
  });

  const matching = wanted === 'ALL' ? all : all.filter((r) => r.readiness === wanted);
  const ordered = newestFirst ? [...matching].reverse() : matching;

  const totalPages = Math.max(1, Math.ceil(ordered.length / size));
  const current = Math.min(Math.max(Number(page) || 1, 1), totalPages);
  const from = (current - 1) * size;

  return {
    summary: {
      activeTags: new Set(all.map((r) => r.bagTagId)).size,
      activeItems: all.length,
      matchingItems: ordered.length,
      readyForField: all.filter((r) => r.readiness === 'READY_FOR_FIELD').length,
      partiallyIssued: all.filter((r) => r.readiness === 'PARTIALLY_ISSUED').length,
      stale: all.filter((r) => r.stale).length,
      staleAfterDays,
      quantity: all.reduce((sum, r) => sum + r.qtyRemaining, 0)
    },
    pagination: {
      page: current,
      pageSize: size,
      totalRecords: ordered.length,
      totalPages,
      hasPrevious: current > 1,
      hasNext: current < totalPages,
      firstRecord: ordered.length ? from + 1 : 0,
      lastRecord: Math.min(from + size, ordered.length)
    },
    records: ordered.slice(from, from + size)
  };
}

/** A shift summary: what moved today, and what is waiting. */
export async function getDashboard(client, projectId) {
  // One client cannot run queries in parallel, so these go in sequence.
  const [activity, queue, bags] = [
    await client.query(
      `SELECT transaction_type, count(*) AS n, coalesce(sum(quantity), 0) AS qty
         FROM material_transactions
        WHERE project_id = $1 AND created_at > now() - interval '24 hours'
        GROUP BY transaction_type`,
      [projectId]
    ),
    await client.query(
      // A request holds its outstanding quantity in the column matching its
      // status: a pending one in qty_pending, a confirmed one in qty_confirmed,
      // and a partially confirmed one split across both. Summing qty_pending
      // alone reported every confirmed backorder as zero — on this project,
      // 246 requests for 423 units the office had committed to supplying,
      // shown on the office's own dashboard as nothing at all.
      `SELECT status, count(*) AS n,
              coalesce(sum(qty_pending), 0) + coalesce(sum(qty_confirmed), 0) AS qty
         FROM backorder_requests
        WHERE project_id = $1 AND active
        GROUP BY status`,
      [projectId]
    ),
    await client.query(
      `SELECT count(*) AS n, coalesce(sum(i.qty_remaining_in_bag), 0) AS qty
         FROM bag_tag_items i
         JOIN bag_tags t ON t.id = i.bag_tag_id
        WHERE t.project_id = $1 AND i.status = 'Active'`,
      [projectId]
    )
  ];

  return {
    last24h: Object.fromEntries(
      activity.rows.map((r) => [r.transaction_type, { count: Number(r.n), quantity: Number(r.qty) }])
    ),
    backorders: Object.fromEntries(
      queue.rows.map((r) => [r.status, { count: Number(r.n), quantity: Number(r.qty) }])
    ),
    activeBags: { count: Number(bags.rows[0].n), quantity: Number(bags.rows[0].qty) }
  };
}

const pct = (part, whole) =>
  Number(whole) > 0 ? Math.round((Number(part) / Number(whole)) * 100) : 0;
