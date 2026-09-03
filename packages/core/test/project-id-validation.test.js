/**
 * The project id arrives in a header, so it is whatever the caller typed.
 *
 * It goes into a query as a uuid. Postgres refuses a malformed one safely —
 * it is a parameter, never interpolated, so `' OR '1'='1` is a type error and
 * not an injection. But it refuses it as a 500 with a stack trace, which means
 * anyone could fill the log with noise and bury real errors in it.
 *
 * Checking the shape first turns that into a plain 400. These cases are the
 * ones an actual probe sent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticate, AuthError } from '../../api/src/auth.js';

// authenticate() reads the session before it looks at the header, so a request
// with no cookie stops at "please sign in" and never reaches the check under
// test. These use a signed session, and stop before any query runs.
process.env.SESSION_SECRET ??= 'test-secret-for-header-validation';

const { issueSession } = await import('../../api/src/auth.js');
const cookie = `fmr_session=${issueSession({ id: '11111111-1111-1111-1111-111111111111', email: 'a@b.c' })}`;

const request = (projectId) => ({
  headers: { cookie, ...(projectId === undefined ? {} : { 'x-project-id': projectId }) }
});

const refusedWith = async (projectId, status, pattern) => {
  await assert.rejects(
    () => authenticate(request(projectId)),
    (error) => {
      assert.ok(error instanceof AuthError, `expected an AuthError, got ${error?.name}`);
      assert.equal(error.status, status);
      assert.match(error.message, pattern);
      return true;
    }
  );
};

test('a SQL injection attempt in the project header is refused as a bad request', () =>
  refusedWith("' OR '1'='1", 400, /not valid/));

test('a path traversal attempt in the project header is refused', () =>
  refusedWith('../admin', 400, /not valid/));

test('the string "null" is not mistaken for a project', () =>
  refusedWith('null', 400, /not valid/));

test('a missing project header says so, rather than being read as invalid', () =>
  refusedWith(undefined, 400, /No project selected/));

test('an empty project header is treated as missing', () =>
  refusedWith('', 400, /No project selected/));

test('a well-formed uuid gets past the shape check', async () => {
  // It reaches the database and fails there, on a user that does not exist —
  // which is the point: the header itself was accepted as well-formed.
  await assert.rejects(
    () => authenticate(request('d0c9a881-7181-4bfb-a98e-0dd10921e415')),
    (error) => {
      assert.ok(!/not valid/.test(String(error.message)),
        `a well-formed id must not be rejected by the shape check, got: ${error.message}`);
      return true;
    }
  );
});
