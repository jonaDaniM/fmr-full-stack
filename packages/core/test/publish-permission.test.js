/**
 * Who may publish.
 *
 * The workflow grants PUBLISH to assignNumber — Jonathan's material manager
 * releases the numbered requisition. The route demanded ownerEdit, so that
 * person was shown a Publish button that could only ever answer 403.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { TRANSITIONS } from '../src/domain/workflow.js';

const server = await readFile(
  fileURLToPath(new URL('../../api/src/server.js', import.meta.url)), 'utf8'
);

test('the publish route accepts whoever the workflow lets publish', () => {
  const needed = TRANSITIONS.PUBLISH.permission;

  const route = server.slice(server.indexOf("/^\\/api\\/import\\/publish$/"));
  const guard = route.slice(0, route.indexOf('readBody'));

  assert.ok(
    guard.includes(needed),
    `the workflow grants PUBLISH to ${needed}, but the route does not accept it`
  );
});

test('publishing is still refused to someone with neither permission', () => {
  const route = server.slice(server.indexOf("/^\\/api\\/import\\/publish$/"));
  const guard = route.slice(0, route.indexOf('readBody'));

  assert.ok(/require(Any|Permission)\(/.test(guard),
    'the publish route no longer checks permissions at all');
});
