/**
 * The seeded users must be able to reach the screens their role implies.
 *
 * Adding a permission means touching four places, and the seed is the one
 * easiest to forget: it names the columns explicitly, so a new boolean simply
 * defaults to false and nobody notices until a fresh database has an owner who
 * cannot approve anything. That happened.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const seed = await readFile(
  fileURLToPath(new URL('../../../db/seed/seed.js', import.meta.url)), 'utf8'
);

/** The permission columns the members INSERT actually writes. */
function insertedColumns() {
  const match = seed.match(/INSERT INTO project_members\s*\(([^)]*)\)/);
  assert.ok(match, 'the seed still inserts project members');
  return match[1].split(',').map((c) => c.trim()).filter((c) => c.startsWith('can_'));
}

test('the seed writes every permission column the schema has', async () => {
  const migrations = await readFile(
    fileURLToPath(new URL('../../../db/migrations/011_approval_chain.sql', import.meta.url)),
    'utf8'
  );

  const added = [...migrations.matchAll(/ADD COLUMN IF NOT EXISTS (can_\w+)/g)]
    .map((m) => m[1]);
  assert.ok(added.length, 'migration 011 still adds permission columns');

  const written = insertedColumns();
  for (const column of added) {
    assert.ok(written.includes(column),
      `the seed does not set ${column}, so every seeded user gets false`);
  }
});

test('every seeded user supplies one value per permission column', () => {
  const columns = insertedColumns().length;
  const perms = [...seed.matchAll(/perms: \[([^\]]+)\]/g)]
    .map((m) => m[1].split(',').length);

  assert.ok(perms.length >= 4, 'the seed still defines users');
  for (const count of perms) {
    assert.equal(count, columns,
      `a user lists ${count} permissions but the INSERT writes ${columns}`);
  }
});

test('the seeded owner can reach the review queue', () => {
  // reviewQueue returns nothing at all unless one of these is true, so an
  // owner without them opens Review to an empty screen with no explanation.
  const owner = seed.match(/role: 'Owner',\s*\n\s*perms: \[([^\]]+)\]/);
  assert.ok(owner, 'there is still a seeded owner');

  const values = owner[1].split(',').map((v) => v.trim() === 'true');
  const columns = insertedColumns();
  const planReview = values[columns.indexOf('can_plan_review')];
  const assignNumber = values[columns.indexOf('can_assign_number')];

  assert.ok(planReview && assignNumber,
    'the owner cannot approve or number anything on a fresh database');
});

test('somebody in the seed can assign an FMR number', () => {
  // Jonathan asked that numbering be a material admin's job. If no seeded user
  // has it, that half of the chain cannot be demonstrated at all.
  const columns = insertedColumns();
  const index = columns.indexOf('can_assign_number');
  const anyone = [...seed.matchAll(/perms: \[([^\]]+)\]/g)]
    .some((m) => m[1].split(',')[index]?.trim() === 'true');

  assert.ok(anyone, 'no seeded user can assign a number');
});
