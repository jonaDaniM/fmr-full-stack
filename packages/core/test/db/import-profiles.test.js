/**
 * Per-project import profiles against a real database.
 *
 * The fitting logic is tested pure in profile-fit.test.js. This covers what
 * only exists with a database: that a project's profile overrides the built-in
 * baseline, that a broken one is refused before it can empty somebody's next
 * import, and that names cannot collide.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { enabled, connect, close, fixture } from './harness.js';

const skip = enabled ? false : 'set FMR_TEST_DATABASE_URL to run';

test.after(async () => { if (enabled) await close(); });

const usable = {
  headerSearchRows: 30,
  columns: {
    description: ['Nomenclature'],
    quantity: ["Req'd Qty"],
    size: ['NPD']
  }
};

test('a new project sees the built-in profiles and nothing else', { skip }, async () => {
  const { pool, profiles } = await connect();
  const f = await fixture();

  const client = await pool.connect();
  try {
    const list = await profiles.listProfiles(client, f.projectId);
    assert.deepEqual(list.map((p) => p.name).sort(), ['default', 'extracted', 'takeoff']);
    assert.ok(list.every((p) => p.builtIn));
  } finally { client.release(); }
});

test('a saved profile is offered beside the built-ins', { skip }, async () => {
  const { pool, profiles } = await connect();
  const f = await fixture();

  const client = await pool.connect();
  try {
    await profiles.saveProfile(client, f.ctx, {
      name: 'Midwest', description: 'Different drafting office',
      definition: usable, basedOn: 'default'
    });

    const list = await profiles.listProfiles(client, f.projectId);
    const saved = list.find((p) => p.name === 'Midwest');
    assert.ok(saved);
    assert.equal(saved.builtIn, false);
    assert.equal(saved.basedOn, 'default');
  } finally { client.release(); }
});

test("a project's profile overrides the built-in of the same name", { skip }, async () => {
  const { pool, profiles } = await connect();
  const f = await fixture();

  const client = await pool.connect();
  try {
    const beforeDefinition = await profiles.resolveProfile(client, f.projectId, 'default');
    assert.ok(beforeDefinition.columns.quantity.includes('Qty'), 'the baseline');

    await profiles.saveProfile(client, f.ctx, {
      name: 'default', definition: usable, basedOn: 'default'
    });

    const after = await profiles.resolveProfile(client, f.projectId, 'default');
    assert.deepEqual(after.columns.quantity, ["Req'd Qty"], 'the project wins');

    // And the built-in is no longer offered twice.
    const list = await profiles.listProfiles(client, f.projectId);
    assert.equal(list.filter((p) => p.name.toLowerCase() === 'default').length, 1);
  } finally { client.release(); }
});

test('one project cannot see another project profile', { skip }, async () => {
  const { pool, profiles } = await connect();
  const f = await fixture();

  const other = (await pool.query(
    `INSERT INTO projects (code,name) VALUES ('P2','Other') RETURNING id`)).rows[0].id;

  const client = await pool.connect();
  try {
    await profiles.saveProfile(client, f.ctx, {
      name: 'Midwest', definition: usable, basedOn: 'default'
    });

    const theirs = await profiles.listProfiles(client, other);
    assert.ok(!theirs.some((p) => p.name === 'Midwest'));

    // And theirs resolves to the baseline, not ours.
    const resolved = await profiles.resolveProfile(client, other, 'Midwest');
    assert.ok(resolved.columns.quantity.includes('Qty'), 'fell back to the baseline');
  } finally { client.release(); }
});

test('a profile that could not import anything is refused', { skip }, async () => {
  const { pool, profiles } = await connect();
  const f = await fixture();

  const client = await pool.connect();
  try {
    await assert.rejects(
      profiles.saveProfile(client, f.ctx, {
        name: 'Broken', definition: { columns: { size: ['Size'] } }
      }),
      /quantity/
    );
  } finally { client.release(); }
});

test('two profiles cannot share a name in one project', { skip }, async () => {
  const { pool, profiles } = await connect();
  const f = await fixture();

  const client = await pool.connect();
  try {
    await profiles.saveProfile(client, f.ctx, { name: 'Midwest', definition: usable });
    await assert.rejects(
      profiles.saveProfile(client, f.ctx, { name: 'Midwest', definition: usable }),
      /already has a profile called/
    );
  } finally { client.release(); }
});

test('a profile can be edited and read back', { skip }, async () => {
  const { pool, profiles } = await connect();
  const f = await fixture();

  const client = await pool.connect();
  try {
    const saved = await profiles.saveProfile(client, f.ctx, {
      name: 'Midwest', definition: usable
    });

    const widened = {
      ...usable,
      columns: { ...usable.columns, quantity: ["Req'd Qty", 'QTY REQD'] }
    };
    await profiles.saveProfile(client, f.ctx, {
      id: saved.id, name: 'Midwest', definition: widened
    });

    const read = await profiles.getProfile(client, f.projectId, saved.id);
    assert.deepEqual(read.definition.columns.quantity, ["Req'd Qty", 'QTY REQD']);
  } finally { client.release(); }
});

test('a deleted profile falls back to the baseline rather than failing', { skip }, async () => {
  const { pool, profiles } = await connect();
  const f = await fixture();

  const client = await pool.connect();
  try {
    const saved = await profiles.saveProfile(client, f.ctx, {
      name: 'Midwest', definition: usable
    });
    await profiles.deleteProfile(client, f.ctx, saved.id);

    const resolved = await profiles.resolveProfile(client, f.projectId, 'Midwest');
    assert.ok(resolved.columns.quantity.includes('Qty'), 'the baseline, not an error');
  } finally { client.release(); }
});

test('a profile needs a name', { skip }, async () => {
  const { pool, profiles } = await connect();
  const f = await fixture();

  const client = await pool.connect();
  try {
    await assert.rejects(
      profiles.saveProfile(client, f.ctx, { name: '   ', definition: usable }),
      /Give the profile a name/
    );
  } finally { client.release(); }
});
