/**
 * Roles have to survive the round trip through the database.
 *
 * Its own file so it gets its own pool: the harness builds one schema per test
 * file and closes the pool when that file's suite ends.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { enabled, connect, close, fixture } from './harness.js';

const skip = enabled ? false : 'set FMR_TEST_DATABASE_URL to run';

test('roles survive being saved and read again', { skip }, async (t) => {
  const { pool } = await connect();
  t.after(close);

  const admin = await import('../../src/services/admin.js');

  await t.test('a planner reviews but does not number', async () => {
    const f = await fixture();
    await admin.saveMember(f.ctx, {
      email: 'pat.planner@test.com', name: 'Pat Planner', profile: 'PLANNER'
    });

    const client = await pool.connect();
    try {
      const { members } = await admin.listMembers(client, f.projectId);
      const planner = members.find((m) => m.email === 'pat.planner@test.com');

      assert.equal(planner.profile, 'PLANNER',
        'a named profile came back as something else');
      assert.equal(planner.permissions.planReview, true);
      assert.equal(planner.permissions.assignNumber, false);
    } finally {
      client.release();
    }
  });

  await t.test('the material admin comes back owning the number', async () => {
    const f = await fixture();
    await admin.saveMember(f.ctx, {
      email: 'morgan.material@test.com', name: 'Morgan Material', profile: 'ADMIN'
    });

    const client = await pool.connect();
    try {
      const { members } = await admin.listMembers(client, f.projectId);
      const mm = members.find((m) => m.email === 'morgan.material@test.com');

      assert.equal(mm.profile, 'ADMIN');
      assert.equal(mm.permissions.assignNumber, true,
        'the client asked for numbering to sit with Material Admin');
      assert.equal(mm.permissions.planReview, false);
    } finally {
      client.release();
    }
  });

  await t.test('every named profile round-trips, not just the new ones', async () => {
    const f = await fixture();
    for (const profile of ['READ_ONLY', 'FIELD', 'PLANNER', 'ADMIN']) {
      await admin.saveMember(f.ctx, {
        email: `${profile.toLowerCase()}@roundtrip.test.com`,
        name: profile, profile
      });
    }

    const client = await pool.connect();
    try {
      const { members } = await admin.listMembers(client, f.projectId);
      for (const profile of ['READ_ONLY', 'FIELD', 'PLANNER', 'ADMIN']) {
        const found = members.find((m) => m.email === `${profile.toLowerCase()}@roundtrip.test.com`);
        assert.equal(found?.profile, profile, `${profile} did not round-trip`);
      }
    } finally {
      client.release();
    }
  });
});
