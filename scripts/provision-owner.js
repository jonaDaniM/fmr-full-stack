/**
 * Give somebody a way in to a fresh deployment.
 *
 * Accounts are provisioned by an admin, never created on sign-in, which
 * leaves a new deployment with nobody who can reach the screen that
 * provisions accounts. This is the way past that, and the only thing it will
 * do: name an owner, and make sure there is a project for them to own.
 *
 *   node scripts/provision-owner.js someone@example.com "Their Name" [PROJECT]
 *
 * Safe to re-run — an existing user is granted access rather than duplicated.
 * It grants owner rights, so run it for the people who set the system up and
 * let them add everyone else through the admin screen, where the guards
 * against removing the last owner apply.
 */

import { pool } from '../packages/core/src/db/pool.js';

const [email, name, projectCode = 'DEMO'] = process.argv.slice(2);

if (!email || !name) {
  console.error('usage: node scripts/provision-owner.js <email> <name> [project]');
  process.exit(1);
}

const address = String(email).trim().toLowerCase();

// Google gives back a verified address and the app matches on it exactly, so
// a typo here reads as "This account has not been set up" with nothing to say
// why. Catching the obvious shape now is cheaper than that.
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
  console.error(`"${email}" is not an email address.`);
  process.exit(1);
}

const { rows: [project] } = await pool.query(
  `INSERT INTO projects (code, name) VALUES ($1, $2)
   ON CONFLICT (code) DO UPDATE SET name = projects.name
   RETURNING id, code, name`,
  [projectCode, projectCode === 'DEMO' ? 'Demo Project' : projectCode]
);

const { rows: [user] } = await pool.query(
  `INSERT INTO users (email, display_name) VALUES ($1, $2)
   ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name
   RETURNING id, email, display_name`,
  [address, String(name).trim()]
);

await pool.query(
  `INSERT INTO project_members
     (project_id, user_id, role, can_search, can_field_transact,
      can_admin_backorder, can_owner_edit)
   VALUES ($1, $2, 'System Owner', true, true, true, true)
   ON CONFLICT (project_id, user_id) DO UPDATE SET
     role = 'System Owner', can_search = true, can_field_transact = true,
     can_admin_backorder = true, can_owner_edit = true`,
  [project.id, user.id]
);

console.log(`${user.display_name} <${user.email}> owns ${project.code}`);

await pool.end();
