/**
 * Data integrity checks.
 *
 * The schema's CHECK constraints stop a single row going wrong. They cannot
 * see across rows — whether a line's backorder quantities match the requests
 * behind them, whether bagged material matches what the bags actually hold,
 * whether a line's issued total matches its own transaction history.
 *
 * Those are the checks that live here. In FMRv3 this ran as a diagnostic over
 * the whole spreadsheet; here each one is a query, and each names the rows it
 * found so a person can go and look.
 *
 * Ported from FMRv3 IntegrityService.gs (inspectFmrV3DataIntegrity).
 */

const CHECKS = [
  {
    code: 'BACKORDER_LEDGER_MISMATCH',
    name: 'Line backorder totals match their requests',
    detail:
      'A line records how much is on backorder; the requests record the same. ' +
      'When they disagree the office and the crew are working from different numbers.',
    sql: `
      SELECT l.id, h.fmr_number, l.line_number, l.material_description,
             l.qty_pending_backorder   AS line_pending,
             l.qty_confirmed_backorder AS line_confirmed,
             coalesce(b.pending, 0)    AS request_pending,
             coalesce(b.confirmed, 0)  AS request_confirmed
        FROM fmr_lines l
        JOIN fmr_headers h ON h.id = l.fmr_id
        LEFT JOIN (
          SELECT fmr_line_id,
                 sum(qty_pending)   AS pending,
                 sum(qty_confirmed) AS confirmed
            FROM backorder_requests
           WHERE active
           GROUP BY fmr_line_id
        ) b ON b.fmr_line_id = l.id
       WHERE l.project_id = $1 AND l.active
         AND (abs(l.qty_pending_backorder   - coalesce(b.pending, 0))   > 0.0001
           OR abs(l.qty_confirmed_backorder - coalesce(b.confirmed, 0)) > 0.0001)`
  },
  {
    code: 'BAG_LEDGER_MISMATCH',
    name: 'Bagged quantities match what the bags hold',
    detail:
      'A line says how much is bagged; the bags say how much is in them. ' +
      'A mismatch means material is reserved on paper but not in a bag, or the reverse.',
    sql: `
      SELECT l.id, h.fmr_number, l.line_number, l.material_description,
             l.qty_active_bagged AS line_bagged,
             coalesce(i.in_bags, 0) AS actually_in_bags
        FROM fmr_lines l
        JOIN fmr_headers h ON h.id = l.fmr_id
        LEFT JOIN (
          SELECT fmr_line_id, sum(qty_remaining_in_bag) AS in_bags
            FROM bag_tag_items
           WHERE status = 'Active'
           GROUP BY fmr_line_id
        ) i ON i.fmr_line_id = l.id
       WHERE l.project_id = $1 AND l.active
         AND abs(l.qty_active_bagged - coalesce(i.in_bags, 0)) > 0.0001`
  },
  {
    code: 'ISSUED_HISTORY_MISMATCH',
    name: 'Issued totals match the transaction history',
    detail:
      'What a line says was issued should equal the sum of its issue transactions, ' +
      'less anything corrected. This is the check that catches a lost or duplicated write.',
    sql: `
      SELECT l.id, h.fmr_number, l.line_number, l.material_description,
             l.qty_issued AS line_issued,
             coalesce(t.issued, 0) AS transaction_issued
        FROM fmr_lines l
        JOIN fmr_headers h ON h.id = l.fmr_id
        LEFT JOIN (
          SELECT fmr_line_id, sum(quantity) AS issued
            FROM material_transactions
           WHERE transaction_type IN
                 ('DIRECT_ISSUE','ISSUE_FROM_AVAILABLE','ISSUE_FROM_BAG',
                  'CORRECTION_DIRECT_ISSUE','CORRECTION_ISSUE_FROM_AVAILABLE',
                  'CORRECTION_ISSUE_FROM_BAG')
           GROUP BY fmr_line_id
        ) t ON t.fmr_line_id = l.id
       WHERE l.project_id = $1 AND l.active
         AND abs(l.qty_issued - coalesce(t.issued, 0)) > 0.0001`
  },
  {
    code: 'BACKORDER_EXCEEDS_OUTSTANDING',
    name: 'Backorders do not exceed what is still to find',
    detail:
      'More material is on backorder than the line still needs located — ' +
      'usually a request that should have been settled when material turned up.',
    sql: `
      SELECT l.id, h.fmr_number, l.line_number, l.material_description,
             l.qty_pending_backorder + l.qty_confirmed_backorder AS on_backorder,
             l.qty_not_yet_located AS still_to_find
        FROM fmr_lines l
        JOIN fmr_headers h ON h.id = l.fmr_id
       WHERE l.project_id = $1 AND l.active
         AND l.qty_pending_backorder + l.qty_confirmed_backorder
             > l.qty_not_yet_located + 0.0001`
  },
  {
    code: 'ORPHANED_BAG_ITEM',
    name: 'Every bag item belongs to an active line',
    detail: 'Material sits in a bag against a line that is no longer active.',
    sql: `
      SELECT i.id, t.tag_number, h.fmr_number, l.line_number,
             i.qty_remaining_in_bag
        FROM bag_tag_items i
        JOIN bag_tags t   ON t.id = i.bag_tag_id
        JOIN fmr_lines l  ON l.id = i.fmr_line_id
        JOIN fmr_headers h ON h.id = l.fmr_id
       WHERE t.project_id = $1
         AND i.status = 'Active'
         AND i.qty_remaining_in_bag > 0
         AND NOT l.active`
  },
  {
    code: 'STATUS_DISAGREES_WITH_QUANTITIES',
    name: 'Line status matches the quantities',
    detail:
      'Status is derived from quantities. A line marked Issued with material ' +
      'still outstanding means a status was written by something other than the ledger.',
    sql: `
      SELECT l.id, h.fmr_number, l.line_number, l.line_status,
             l.qty_remaining_requirement, l.qty_issued, l.qty_requested
        FROM fmr_lines l
        JOIN fmr_headers h ON h.id = l.fmr_id
       WHERE l.project_id = $1 AND l.active
         AND ((l.line_status = 'Issued'    AND l.qty_remaining_requirement > 0.0001)
           OR (l.line_status = 'Open'      AND l.qty_confirmed_located > 0.0001)
           OR (l.qty_remaining_requirement <= 0.0001 AND l.qty_requested > 0
               AND l.line_status <> 'Issued'))`
  },
  {
    code: 'ACTIVE_NOTICE_WITHOUT_REQUEST',
    name: 'Notices point at a live request',
    detail:
      'A notice is still on a crew card but the request behind it is gone. ' +
      'They are being asked to act on something that no longer exists.',
    sql: `
      SELECT n.id, h.fmr_number, l.line_number, n.kind, n.headline, n.qty_outstanding
        FROM field_notices n
        JOIN fmr_lines l   ON l.id = n.fmr_line_id
        JOIN fmr_headers h ON h.id = n.fmr_id
       WHERE n.project_id = $1
         AND n.status = 'Active'
         AND n.source_request_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM backorder_requests b
            WHERE b.id = n.source_request_id AND b.active
         )`
  }
];

/**
 * Run every check against one project.
 *
 * Read-only: reports what it finds and changes nothing. Repairs are a separate,
 * deliberate act — see repairBackorderTotals below.
 */
export async function inspectIntegrity(client, projectId) {
  const results = [];

  for (const check of CHECKS) {
    const { rows } = await client.query(check.sql, [projectId]);

    results.push({
      code: check.code,
      name: check.name,
      detail: check.detail,
      ok: rows.length === 0,
      count: rows.length,
      // Enough rows to act on, not so many the report is unreadable.
      examples: rows.slice(0, 20)
    });
  }

  return {
    ok: results.every((r) => r.ok),
    checkedAt: new Date().toISOString(),
    checks: results,
    problemCount: results.reduce((total, r) => total + r.count, 0)
  };
}

/**
 * Bring a line's backorder totals back into line with its requests.
 *
 * The requests are the record of what the office was actually asked and what
 * it decided, so they win. Only touches lines that are already wrong, and
 * writes an audit row for each.
 */
export async function repairBackorderTotals(ctx, { lineIds } = {}) {
  const { user, projectId } = ctx;

  const { rows } = await ctx.client.query(
    `WITH totals AS (
       SELECT l.id,
              l.qty_pending_backorder   AS was_pending,
              l.qty_confirmed_backorder AS was_confirmed,
              coalesce(sum(b.qty_pending)   FILTER (WHERE b.active), 0) AS pending,
              coalesce(sum(b.qty_confirmed) FILTER (WHERE b.active), 0) AS confirmed
         FROM fmr_lines l
         LEFT JOIN backorder_requests b ON b.fmr_line_id = l.id
        WHERE l.project_id = $1 AND l.active
          ${lineIds?.length ? 'AND l.id = ANY($2::uuid[])' : ''}
        GROUP BY l.id
     )
     UPDATE fmr_lines l
        SET qty_pending_backorder = t.pending,
            qty_confirmed_backorder = t.confirmed,
            updated_at = now()
       FROM totals t
      WHERE l.id = t.id
        AND (abs(l.qty_pending_backorder   - t.pending)   > 0.0001
          OR abs(l.qty_confirmed_backorder - t.confirmed) > 0.0001)
      RETURNING l.id, t.was_pending, t.was_confirmed, t.pending, t.confirmed`,
    lineIds?.length ? [projectId, lineIds] : [projectId]
  );

  for (const row of rows) {
    await ctx.client.query(
      `INSERT INTO audit_log
         (project_id, entity_type, entity_id, action, payload, user_id, user_email,
          source_interface)
       VALUES ($1,'FMR_LINE',$2,'INTEGRITY_REPAIR',$3,$4,$5,'OWNER')`,
      [
        projectId, row.id,
        {
          pendingBackorder: { from: Number(row.was_pending), to: Number(row.pending) },
          confirmedBackorder: { from: Number(row.was_confirmed), to: Number(row.confirmed) }
        },
        user.id, user.email
      ]
    );
  }

  return { repaired: rows.length, lines: rows.map((r) => r.id) };
}

export { CHECKS };
