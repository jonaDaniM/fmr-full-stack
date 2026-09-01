/**
 * Demo data.
 *
 * Two job sites, a handful of users, and FMR lines covering every state the
 * field screen can show: untouched, partly located, bagged, partly issued,
 * fully issued, and one sitting on a pending backorder.
 */

import { pool } from '../../packages/core/src/db/pool.js';

const PROJECTS = [
  { code: 'GC-2026', name: 'Gulf Coast Turnaround' },
  { code: 'MW-2026', name: 'Midwest Expansion' }
];

const USERS = [
  { email: 'jonathan@example.com', name: 'Jonathan D.', role: 'Owner',
    perms: [true, true, true, true] },
  { email: 'warehouse@example.com', name: 'Rita Alvarez', role: 'Warehouse',
    perms: [true, true, false, false] },
  { email: 'expeditor@example.com', name: 'Sam Okafor', role: 'Expeditor',
    perms: [true, false, true, false] },
  { email: 'foreman@example.com', name: 'Dale Hughes', role: 'Field',
    perms: [true, true, false, false] }
];

const LINES = [
  // iso,     sht,  commodity,        size,     desc,                              qty, uom, state
  ['D-4410', '01', 'PF-A106-STD', '6"',   'PIPE, CS A106 GR B, SMLS, STD',    120, 'FT', 'open'],
  ['D-4410', '01', 'EL90-A234-STD', '6"',  'ELBOW 90 LR, A234 WPB, BW, STD',    18, 'EA', 'located'],
  ['D-4410', '01', 'FLWN-A105-150', '6"',  'FLANGE, WN, A105, 150#, RF',        12, 'EA', 'bagged'],
  ['D-4410', '02', 'GKT-SPWD-150', '6"',   'GASKET, SPIRAL WOUND, 150#',        24, 'EA', 'part-issued'],
  ['D-4410', '02', 'STUD-B7-2H', '3/4" x 4-1/2"', 'STUD BOLT B7 W/ 2H NUTS',   96, 'EA', 'issued'],
  ['D-4411', '01', 'PF-A312-316L', '4"',   'PIPE, SS A312 TP316L, SCH 10S',     80, 'FT', 'backorder'],
  ['D-4411', '01', 'TEE-A403-316L', '4"',  'TEE, EQUAL, A403 WP316L, BW',        6, 'EA', 'open'],
  ['D-4411', '02', 'VLV-BALL-150', '2"',   'VALVE, BALL, 150#, FULL PORT',       4, 'EA', 'part-located']
];

async function seed() {
  console.log('seeding…');

  await pool.query('BEGIN');
  try {
    // --- projects
    const projectIds = {};
    for (const p of PROJECTS) {
      const { rows } = await pool.query(
        `INSERT INTO projects (code, name) VALUES ($1,$2)
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [p.code, p.name]
      );
      projectIds[p.code] = rows[0].id;
    }

    // --- users, with access to both sites
    const userIds = {};
    for (const u of USERS) {
      const { rows } = await pool.query(
        `INSERT INTO users (email, display_name) VALUES ($1,$2)
         ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name
         RETURNING id`,
        [u.email, u.name]
      );
      userIds[u.email] = rows[0].id;

      for (const projectId of Object.values(projectIds)) {
        await pool.query(
          `INSERT INTO project_members
             (project_id, user_id, role, can_search, can_field_transact,
              can_admin_backorder, can_owner_edit)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
          [projectId, rows[0].id, u.role, ...u.perms]
        );
      }
    }

    // --- lists
    const projectId = projectIds['GC-2026'];
    const owner = userIds['jonathan@example.com'];
    const rita = userIds['warehouse@example.com'];

    // Backorder reasons, UOMs and priorities come from migration 005 as
    // shared values that apply to every project. Only what is specific to this
    // site belongs here.
    for (const [name, values] of Object.entries({
      STORAGE_LOCATION: ['Yard A', 'Yard B', 'Rack 12', 'Conex 4', 'Laydown East']
    })) {
      for (const [i, value] of values.entries()) {
        await pool.query(
          `INSERT INTO lists (project_id, list_name, value, sort_order)
           VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [projectId, name, value, i]
        );
      }
    }

    // --- one FMR carrying every line state
    const { rows: headerRows } = await pool.query(
      `INSERT INTO fmr_headers
         (project_id, fmr_number, iwp_number, requested_by, date_required,
          priority, created_by, updated_by)
       VALUES ($1,'FMR-2026-0417','IWP-88-014','Dale Hughes',
               current_date + 7,'High',$2,$2)
       ON CONFLICT (project_id, fmr_number) DO UPDATE SET updated_at = now()
       RETURNING id`,
      [projectId, owner]
    );
    const fmrId = headerRows[0].id;

    await pool.query('DELETE FROM fmr_lines WHERE fmr_id = $1', [fmrId]);

    const { rows: tagRows } = await pool.query(
      `INSERT INTO bag_tags
         (project_id, tag_number, fmr_id, iso_key, storage_location,
          bagged_by, bagged_by_name)
       VALUES ($1,'BAG-1042',$2,'D-4410|01','Rack 12',$3,'Rita Alvarez')
       ON CONFLICT (project_id, tag_number) DO UPDATE SET updated_at = now()
       RETURNING id`,
      [projectId, fmrId, rita]
    );
    const bagTagId = tagRows[0].id;

    for (const [i, [iso, sht, code, size, desc, qty, uom, state]] of LINES.entries()) {
      // Work out the ledger for the state this line is meant to show.
      let located = 0, bagged = 0, available = 0, issued = 0, pending = 0, status = 'Open';

      if (state === 'located')      { located = qty; available = qty; status = 'Located'; }
      if (state === 'part-located') { located = 2; available = 2; status = 'Partially Located'; }
      if (state === 'bagged')       { located = qty; bagged = qty; status = 'Bagged'; }
      if (state === 'part-issued')  { located = qty; issued = 10; available = qty - 10;
                                      status = 'Partially Issued'; }
      if (state === 'issued')       { located = qty; issued = qty; status = 'Issued'; }
      if (state === 'backorder')    { pending = 30; status = 'Pending Backorder'; }

      const { rows: lineRows } = await pool.query(
        `INSERT INTO fmr_lines
           (project_id, fmr_id, line_number, iso_number, iso_sheet, commodity_code,
            size, material_description, qty_requested, uom, storage_location,
            qty_confirmed_located, qty_active_bagged, qty_available, qty_issued,
            qty_pending_backorder, line_status, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18)
         RETURNING id`,
        [projectId, fmrId, i + 1, iso, sht, code, size, desc, qty, uom,
         state === 'open' ? null : 'Rack 12',
         located, bagged, available, issued, pending, status, owner]
      );
      const lineId = lineRows[0].id;

      if (state === 'bagged') {
        await pool.query(
          `INSERT INTO bag_tag_items (bag_tag_id, fmr_line_id, qty_bagged)
           VALUES ($1,$2,$3)`,
          [bagTagId, lineId, qty]
        );
      }

      if (state === 'backorder') {
        await pool.query(
          `INSERT INTO backorder_requests
             (project_id, fmr_id, fmr_line_id, qty_requested, qty_pending,
              reason, field_notes, reported_by, reported_by_name, status)
           VALUES ($1,$2,$3,30,30,'Not in stock',
                   'Checked Yard A and Conex 4, none on site.',$4,'Dale Hughes','Pending')`,
          [projectId, fmrId, lineId, userIds['foreman@example.com']]
        );
      }

      if (issued > 0) {
        await pool.query(
          `INSERT INTO material_transactions
             (project_id, correlation_id, fmr_id, fmr_line_id, transaction_type,
              quantity, uom, performed_by, performed_by_name, issued_to_name)
           VALUES ($1, gen_random_uuid(), $2,$3,'ISSUE_FROM_AVAILABLE',$4,$5,$6,
                   'Rita Alvarez','Dale Hughes')`,
          [projectId, fmrId, lineId, issued, uom, rita]
        );
      }
    }

    await pool.query('COMMIT');

    console.log(`  ${PROJECTS.length} projects, ${USERS.length} users`);
    console.log(`  FMR-2026-0417 with ${LINES.length} lines covering every state`);
    console.log('done');
  } catch (error) {
    await pool.query('ROLLBACK');
    console.error('seed failed:', error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

seed();
