/**
 * Office reporting.
 *
 * Two roll-ups the office works from: every FMR with its progress, and the
 * same material grouped by drawing. In FMRv3 these were assembled row by row
 * in Apps Script; here they are single aggregate queries.
 */

/**
 * Every FMR with its progress. The register view.
 *
 * Filters are optional and narrow the list; the choices offered come back
 * alongside the rows, built from what is actually present rather than a fixed
 * list, so a priority nobody uses does not appear.
 */
export async function getRegister(client, projectId, { status, priority } = {}) {
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
       FROM fmr_headers h
       LEFT JOIN fmr_lines l ON l.fmr_id = h.id AND l.active
      WHERE h.project_id = $1 AND h.active
        AND ($2::text IS NULL OR h.current_status = $2)
        AND ($3::text IS NULL OR h.priority = $3)
      GROUP BY h.id
      ORDER BY h.date_required NULLS LAST, h.fmr_number`,
    [projectId, status ?? null, priority ?? null]
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

  const totals = fmrs.reduce(
    (acc, f) => ({
      lines: acc.lines + f.lineCount,
      requested: acc.requested + f.qtyRequested,
      issued: acc.issued + f.qtyIssued,
      backordered: acc.backordered + f.qtyBackordered
    }),
    { lines: 0, requested: 0, issued: 0, backordered: 0 }
  );

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
      priorities: (options[0].priorities ?? []).sort()
    },
    applied: { status: status ?? null, priority: priority ?? null },
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
export async function getIsoSummary(client, projectId) {
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
      WHERE l.project_id = $1 AND l.active
      GROUP BY l.iso_number, l.iso_sheet
      ORDER BY l.iso_number, l.iso_sheet`,
    [projectId]
  );

  return {
    drawings: rows.map((row) => ({
      isoNumber: row.iso_number,
      isoSheet: row.iso_sheet,
      lineCount: Number(row.line_count),
      fmrCount: Number(row.fmr_count),
      qtyRequested: Number(row.qty_requested),
      qtyIssued: Number(row.qty_issued),
      qtyAvailable: Number(row.qty_available),
      qtyBagged: Number(row.qty_bagged),
      qtyBackordered: Number(row.qty_backordered),
      fulfillmentPct: pct(row.qty_issued, row.qty_requested)
    }))
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

/** A shift summary: what moved today, and what is waiting. */
export async function getDashboard(client, projectId) {
  const [activity, queue, bags] = await Promise.all([
    client.query(
      `SELECT transaction_type, count(*) AS n, coalesce(sum(quantity), 0) AS qty
         FROM material_transactions
        WHERE project_id = $1 AND created_at > now() - interval '24 hours'
        GROUP BY transaction_type`,
      [projectId]
    ),
    client.query(
      `SELECT status, count(*) AS n, coalesce(sum(qty_pending), 0) AS qty
         FROM backorder_requests
        WHERE project_id = $1 AND active
        GROUP BY status`,
      [projectId]
    ),
    client.query(
      `SELECT count(*) AS n, coalesce(sum(i.qty_remaining_in_bag), 0) AS qty
         FROM bag_tag_items i
         JOIN bag_tags t ON t.id = i.bag_tag_id
        WHERE t.project_id = $1 AND i.status = 'Active'`,
      [projectId]
    )
  ]);

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
