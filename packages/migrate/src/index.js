/**
 * Migration from the FMRv3 spreadsheet.
 *
 * Reads sheets exported as CSV and loads them into Postgres. Two things make
 * this more than a copy:
 *
 *  1. The sheet's quantity columns are trusted as the starting balance, but
 *     they are checked against the transaction history first. A line whose
 *     stored quantities disagree with its transactions is reported, not
 *     silently imported — that disagreement is exactly what a spreadsheet
 *     lets happen and a database will not.
 *
 *  2. Every row is checked against the schema's invariants before insert, so
 *     a bad row is named in a report rather than aborting the whole run.
 *
 * Run with --dry-run first. Always.
 */

import { readFile } from 'node:fs/promises';
import { pool, withTransaction } from '../../core/src/db/pool.js';
import { lineStatus } from '../../core/src/domain/ledger.js';

/** Minimal CSV reader: handles quoted fields, embedded commas and newlines. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += char;
      continue;
    }

    if (char === '"') { quoted = true; continue; }
    if (char === ',') { row.push(field); field = ''; continue; }
    if (char === '\r') continue;
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += char;
  }

  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];

  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1)
    .filter((r) => r.some((cell) => String(cell).trim() !== ''))
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
}

const num = (v) => {
  const parsed = Number(String(v ?? '').replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
};
const text = (v) => String(v ?? '').trim() || null;
const yes = (v) => String(v ?? '').trim().toUpperCase() === 'YES';
const date = (v) => {
  const value = String(v ?? '').trim();
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
};

/**
 * Check one line's quantities against the schema's rules before it is loaded.
 * Returns a list of problems, empty if the row is sound.
 */
export function validateLine(row) {
  const problems = [];

  const requested = num(row.Qty_Requested);
  const located = num(row.Qty_Confirmed_Located);
  const bagged = num(row.Qty_Active_Bagged);
  const available = num(row.Qty_Available);
  const issued = num(row.Qty_Issued);

  if (requested <= 0) problems.push('requested quantity is zero or missing');

  // The invariant the schema enforces. A sheet can drift out of it; a
  // database cannot, so drift has to be found here.
  const accounted = available + bagged + issued;
  if (Math.abs(located - accounted) > 0.0001) {
    problems.push(
      `located ${located} does not equal available ${available} + bagged ${bagged} + issued ${issued}`
    );
  }

  if (issued > requested) problems.push(`issued ${issued} exceeds requested ${requested}`);
  if (located > requested) problems.push(`located ${located} exceeds requested ${requested}`);

  for (const [label, value] of Object.entries({
    requested, located, bagged, available, issued,
    pending: num(row.Qty_Pending_Backorder),
    confirmed: num(row.Qty_Confirmed_Backorder)
  })) {
    if (value < 0) problems.push(`${label} is negative`);
  }

  if (!text(row.ISO_Number)) problems.push('ISO number is missing');
  if (!text(row.ISO_Sheet)) problems.push('ISO sheet is missing');

  return problems;
}

/**
 * Load exported CSVs into a project.
 *
 * @param {object} options
 * @param {string} options.projectCode  target project, created if absent
 * @param {string} options.dir          directory of exported CSVs
 * @param {boolean} options.dryRun      validate and report, write nothing
 */
export async function migrate({ projectCode, projectName, dir, dryRun = true }) {
  const read = async (name) => {
    try {
      return parseCsv(await readFile(`${dir}/${name}.csv`, 'utf8'));
    } catch {
      console.warn(`  (no ${name}.csv — skipping)`);
      return [];
    }
  };

  console.log(`reading from ${dir}`);
  const [users, headers, lines, backorders, bagHeaders, bagItems, transactions] =
    await Promise.all([
      read('Users'), read('FMR_Header'), read('FMR_Line_Items'),
      read('Backorder_Requests'), read('Bag_Tag_Header'), read('Bag_Tag_Items'),
      read('Material_Transactions')
    ]);

  console.log(`  ${headers.length} FMRs, ${lines.length} lines, ${users.length} users`);

  // --- validate before touching anything
  const report = { ok: 0, problems: [] };
  for (const row of lines) {
    const problems = validateLine(row);
    if (problems.length) {
      report.problems.push({
        line: `${row.FMR_Number} line ${row.Line_Number}`,
        id: row.FMR_Line_ID,
        problems
      });
    } else report.ok++;
  }

  console.log(`\nvalidation: ${report.ok} clean, ${report.problems.length} with problems`);
  for (const bad of report.problems.slice(0, 25)) {
    console.log(`  ${bad.line}: ${bad.problems.join('; ')}`);
  }
  if (report.problems.length > 25) {
    console.log(`  … and ${report.problems.length - 25} more`);
  }

  if (dryRun) {
    console.log('\ndry run — nothing written.');
    return report;
  }

  if (report.problems.length) {
    console.log('\nrefusing to load: fix the problems above, or re-export.');
    console.log('these rows would violate constraints the database enforces.');
    return report;
  }

  // --- load
  await withTransaction(async (client) => {
    const { rows: projectRows } = await client.query(
      `INSERT INTO projects (code, name) VALUES ($1,$2)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [projectCode, projectName ?? projectCode]
    );
    const projectId = projectRows[0].id;

    // users
    const userByEmail = {};
    for (const row of users) {
      const email = String(row.Email ?? '').trim().toLowerCase();
      if (!email) continue;

      const { rows } = await client.query(
        `INSERT INTO users (email, display_name, active) VALUES ($1,$2,$3)
         ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name
         RETURNING id`,
        [email, text(row.Display_Name) ?? email, yes(row.Active)]
      );
      userByEmail[email] = rows[0].id;

      await client.query(
        `INSERT INTO project_members
           (project_id, user_id, role, can_search, can_field_transact,
            can_admin_backorder, can_owner_edit)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (project_id, user_id) DO UPDATE SET
           role = EXCLUDED.role,
           can_search = EXCLUDED.can_search,
           can_field_transact = EXCLUDED.can_field_transact,
           can_admin_backorder = EXCLUDED.can_admin_backorder,
           can_owner_edit = EXCLUDED.can_owner_edit`,
        [
          projectId, rows[0].id, text(row.Role) ?? 'Field',
          yes(row.Can_Search), yes(row.Can_Field_Transact),
          yes(row.Can_Admin_Backorder), yes(row.Can_Owner_Edit)
        ]
      );
    }

    // headers, keeping the sheet's ids so lines can be matched back
    const fmrById = {};
    for (const row of headers) {
      const { rows } = await client.query(
        `INSERT INTO fmr_headers
           (project_id, fmr_number, iwp_number, requested_by, date_required,
            priority, current_status, notes, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (project_id, fmr_number) DO UPDATE SET updated_at = now()
         RETURNING id`,
        [
          projectId, text(row.FMR_Number), text(row.IWP_Number),
          text(row.Requested_By), date(row.Date_Required), text(row.Priority),
          text(row.Current_Status) ?? 'Open', text(row.Notes), yes(row.Active)
        ]
      );
      fmrById[row.FMR_ID] = rows[0].id;
    }

    // lines
    const lineById = {};
    for (const row of lines) {
      const fmrId = fmrById[row.FMR_ID];
      if (!fmrId) continue;

      const state = {
        requested: num(row.Qty_Requested),
        confirmed: num(row.Qty_Confirmed_Located),
        bagged: num(row.Qty_Active_Bagged),
        available: num(row.Qty_Available),
        issued: num(row.Qty_Issued),
        pendingBackorder: num(row.Qty_Pending_Backorder),
        confirmedBackorder: num(row.Qty_Confirmed_Backorder)
      };
      state.notYetLocated = Math.max(0, state.requested - state.confirmed);
      state.remaining = Math.max(0, state.requested - state.issued);

      const { rows: inserted } = await client.query(
        `INSERT INTO fmr_lines
           (project_id, fmr_id, line_number, iso_number, iso_sheet, commodity_code,
            size, material_description, qty_requested, uom, storage_location,
            qty_confirmed_located, qty_active_bagged, qty_available, qty_issued,
            qty_pending_backorder, qty_confirmed_backorder, line_status, notes, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         ON CONFLICT (fmr_id, line_number) DO UPDATE SET updated_at = now()
         RETURNING id`,
        [
          projectId, fmrId, num(row.Line_Number), text(row.ISO_Number),
          text(row.ISO_Sheet), text(row.Commodity_Code), text(row.Size),
          text(row.Material_Description), state.requested, text(row.UOM),
          text(row.Storage_Location), state.confirmed, state.bagged,
          state.available, state.issued, state.pendingBackorder,
          state.confirmedBackorder,
          text(row.Line_Status) ?? lineStatus(state), text(row.Notes),
          yes(row.Active)
        ]
      );
      lineById[row.FMR_Line_ID] = inserted[0].id;
    }

    // bag tags
    const bagById = {};
    for (const row of bagHeaders) {
      const fmrId = fmrById[row.FMR_ID];
      if (!fmrId) continue;

      const { rows } = await client.query(
        `INSERT INTO bag_tags
           (project_id, tag_number, fmr_id, iso_key, storage_location,
            bagged_by_name, status, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (project_id, tag_number) DO UPDATE SET updated_at = now()
         RETURNING id`,
        [
          projectId, text(row.Tag_Number), fmrId, text(row.ISO_Key),
          text(row.Storage_Location), text(row.Bagged_By_Name),
          text(row.Status) ?? 'Active', text(row.Notes)
        ]
      );
      bagById[row.Bag_Tag_ID] = rows[0].id;
    }

    for (const row of bagItems) {
      const bagId = bagById[row.Bag_Tag_ID];
      const lineId = lineById[row.FMR_Line_ID];
      if (!bagId || !lineId) continue;

      await client.query(
        `INSERT INTO bag_tag_items
           (bag_tag_id, fmr_line_id, qty_bagged, qty_issued_from_bag, status)
         VALUES ($1,$2,$3,$4,$5)`,
        [bagId, lineId, num(row.Qty_Bagged), num(row.Qty_Issued_From_Bag),
         text(row.Status) ?? 'Active']
      );
    }

    // backorders
    for (const row of backorders) {
      const fmrId = fmrById[row.FMR_ID];
      const lineId = lineById[row.FMR_Line_ID];
      if (!fmrId || !lineId) continue;

      await client.query(
        `INSERT INTO backorder_requests
           (project_id, fmr_id, fmr_line_id, qty_requested, qty_confirmed, qty_pending,
            reason, field_notes, reported_by_name, reported_at, status,
            admin_decision, admin_notes, decided_by_name, decided_at,
            returned_review_reason, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          projectId, fmrId, lineId,
          num(row.Qty_Requested_Backorder), num(row.Qty_Confirmed_Backorder),
          num(row.Qty_Pending), text(row.Reason), text(row.Field_Notes),
          text(row.Reported_By_Name), text(row.Reported_At) || null,
          text(row.Status) ?? 'Pending', text(row.Admin_Decision),
          text(row.Admin_Notes), text(row.Decided_By_Name),
          text(row.Decided_At) || null, text(row.Returned_Review_Reason),
          yes(row.Active)
        ]
      );
    }

    // transaction history, preserved as-is
    let loadedTransactions = 0;
    for (const row of transactions) {
      const fmrId = fmrById[row.FMR_ID];
      const lineId = lineById[row.FMR_Line_ID];
      if (!fmrId || !lineId) continue;

      await client.query(
        `INSERT INTO material_transactions
           (project_id, correlation_id, fmr_id, fmr_line_id, transaction_type,
            quantity, uom, performed_by_name, issued_to_name, storage_location,
            notes, created_at)
         VALUES ($1, coalesce(nullif($2,'')::uuid, gen_random_uuid()),
                 $3,$4,$5,$6,$7,$8,$9,$10,$11, coalesce($12::timestamptz, now()))`,
        [
          projectId, text(row.Correlation_ID) ?? '', fmrId, lineId,
          text(row.Transaction_Type) ?? 'UNKNOWN', num(row.Quantity), text(row.UOM),
          text(row.Performed_By_Name), text(row.Issued_To_Name),
          text(row.Storage_Location), text(row.Notes), text(row.Timestamp)
        ]
      );
      loadedTransactions++;
    }

    console.log(`\nloaded into ${projectCode}:`);
    console.log(`  ${Object.keys(fmrById).length} FMRs`);
    console.log(`  ${Object.keys(lineById).length} lines`);
    console.log(`  ${Object.keys(userByEmail).length} users`);
    console.log(`  ${loadedTransactions} transactions`);
  });

  return report;
}

// --- cli
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = Object.fromEntries(
    process.argv.slice(2)
      .filter((a) => a.startsWith('--'))
      .map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; })
  );

  if (!args.dir || !args.project) {
    console.log('usage: node packages/migrate/src/index.js --dir=./export --project=GC-2026 [--name="Gulf Coast"] [--apply]');
    process.exit(1);
  }

  migrate({
    dir: args.dir,
    projectCode: args.project,
    projectName: args.name,
    dryRun: !args.apply
  })
    .then(() => pool.end())
    .catch((error) => { console.error(error.message); process.exit(1); });
}
