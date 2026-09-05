/**
 * Publishing from the review queue must create the FMR, not just move a state.
 *
 * The review screen's buttons come from the workflow's transitions, so PUBLISH
 * rendered like any other move and went to /api/review/advance — which only
 * writes workflow_state. The item read as PUBLISHED while no FMR existed and
 * no crew could search for it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const review = await readFile(
  fileURLToPath(new URL('../../web/public/review.js', import.meta.url)), 'utf8'
);

test('the review screen publishes through the endpoint that creates the FMR', () => {
  assert.ok(review.includes('/api/import/publish'),
    'publishing from Review must call the real publish endpoint');
});

test('PUBLISH is handled before the generic advance call', () => {
  // Earlier branches (returning for correction) legitimately call advance, so
  // compare against the last one — the fall-through every other action takes.
  const publishAt = review.indexOf("action === 'PUBLISH'");
  const fallThrough = review.lastIndexOf("'/api/review/advance'");

  assert.ok(publishAt > -1, 'PUBLISH is still handled as its own case');
  assert.ok(publishAt < fallThrough,
    'PUBLISH must be intercepted before falling through to advance, '
    + 'which would only change workflow_state');
});

test('publishing asks first, because it cannot be undone', () => {
  const publishAt = review.indexOf("action === 'PUBLISH'");
  const block = review.slice(publishAt, publishAt + 900);
  assert.ok(block.includes('confirmAction'), 'publishing is confirmed first');
  assert.ok(/cannot be undone/i.test(block), 'and says so');
});
