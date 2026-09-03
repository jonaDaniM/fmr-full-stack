/**
 * A real database for the service-layer tests.
 *
 * The domain tests are pure and need nothing. These do: every bug they cover
 * lived in the seam between a correct domain function and the SQL around it,
 * which is exactly what a pure test cannot see.
 *
 * Set FMR_TEST_DATABASE_URL to run them. Without it they skip, so `npm test`
 * stays a fast, database-free suite.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(here, '../../../../db/migrations');

export const DATABASE_URL = process.env.FMR_TEST_DATABASE_URL;
export const enabled = Boolean(DATABASE_URL);

let pool;
let services;

/**
 * Load the schema once, then hand back the service layer bound to it.
 *
 * Each test file runs in its own process and builds the schema from the
 * migrations, so they get a schema each — named for the file — rather than
 * racing to drop and rebuild a shared `public`.
 */
export async function connect() {
  if (services) return services;

  const schema = `test_${basename(process.argv[1] ?? 'db', '.test.js').replace(/\W/g, '_')}`;

  process.env.DATABASE_URL = DATABASE_URL;
  ({ pool } = await import('../../src/db/pool.js'));

  // Every connection in the pool, including ones opened later, works in here.
  pool.on('connect', (client) => client.query(`SET search_path TO ${schema}, public`));

  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}`);
  await pool.query(`SET search_path TO ${schema}, public`);
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    await pool.query(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }

  services = {
    pool,
    field: await import('../../src/services/field.js'),
    corrections: await import('../../src/services/corrections.js'),
    integrity: await import('../../src/services/integrity.js'),
    reporting: await import('../../src/services/reporting.js')
  };
  return services;
}

export async function close() {
  if (pool) await pool.end();
}

/** A project, an owner, one FMR and one line — the smallest thing worth testing. */
export async function fixture({ requested = 100 } = {}) {
  await pool.query(`TRUNCATE projects, users, fmr_headers, fmr_lines, bag_tags,
    bag_tag_items, backorder_requests, material_transactions, audit_log,
    field_notices, corrections, project_members, project_controls CASCADE`);

  const projectId = (await pool.query(
    `INSERT INTO projects (code,name) VALUES ('P1','Test Project') RETURNING id`)).rows[0].id;

  const userId = (await pool.query(
    `INSERT INTO users (email,display_name) VALUES ('crew@test','Crew Hand') RETURNING id`
  )).rows[0].id;

  await pool.query(
    `INSERT INTO project_members (project_id,user_id,role,can_search,can_field_transact,
                                  can_admin_backorder,can_owner_edit)
     VALUES ($1,$2,'OWNER',true,true,true,true)`, [projectId, userId]);

  const fmrId = (await pool.query(
    `INSERT INTO fmr_headers (project_id,fmr_number,current_status)
     VALUES ($1,'FMR-001','Open') RETURNING id`, [projectId])).rows[0].id;

  const lineId = (await pool.query(
    `INSERT INTO fmr_lines (project_id,fmr_id,line_number,material_description,uom,
                            qty_requested,storage_location,iso_number,iso_sheet,active)
     VALUES ($1,$2,1,'2in PIPE SCH40','FT',$3,'RACK 12','D-1234','05',true)
     RETURNING id`, [projectId, fmrId, requested])).rows[0].id;

  const user = { id: userId, email: 'crew@test', display_name: 'Crew Hand' };
  return { projectId, userId, fmrId, lineId, user, ctx: { user, projectId } };
}

/** A second FMR in the same project, with one line. */
export async function secondFmr(projectId, { number = 'FMR-002', requested = 40 } = {}) {
  const fmrId = (await pool.query(
    `INSERT INTO fmr_headers (project_id,fmr_number,current_status)
     VALUES ($1,$2,'Open') RETURNING id`, [projectId, number])).rows[0].id;
  const lineId = (await pool.query(
    `INSERT INTO fmr_lines (project_id,fmr_id,line_number,material_description,uom,
                            qty_requested,storage_location,iso_number,iso_sheet,active)
     VALUES ($1,$2,1,'6in FLANGE','EA',$3,'RACK 3','D-9999','01',true)
     RETURNING id`, [projectId, fmrId, requested])).rows[0].id;
  return { fmrId, lineId };
}

export async function line(lineId) {
  return (await pool.query('SELECT * FROM fmr_lines WHERE id=$1', [lineId])).rows[0];
}

export async function bagItems() {
  return (await pool.query(
    `SELECT qty_bagged, qty_issued_from_bag, qty_remaining_in_bag, status
       FROM bag_tag_items ORDER BY created_at`)).rows;
}

export async function firstTagId() {
  return (await pool.query('SELECT id FROM bag_tags ORDER BY bagged_at LIMIT 1')).rows[0]?.id;
}
