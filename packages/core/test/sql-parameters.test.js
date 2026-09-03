/**
 * The SQL-typing rule, as a test rather than only a script.
 *
 * The parity audit found two statements that could never run: a project id
 * used as both uuid and text, and a uuid parameter inside a CASE branch
 * opposite NULL. Both failed at runtime with 42P08 and both were invisible to
 * this suite, because the domain tests deliberately have no database — a
 * statement that never parses looks exactly like one that works.
 *
 * scripts/check-sql.js reads the SQL instead. This runs it, so a broken query
 * fails the suite rather than waiting to fail an owner pausing work.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const checker = fileURLToPath(new URL('../../../scripts/check-sql.js', import.meta.url));

test('every SQL parameter has one deducible type', async () => {
  const { stdout } = await run(process.execPath, [checker]);
  assert.match(stdout, /one deducible type/);
});
