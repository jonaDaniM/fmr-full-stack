/**
 * Drafts against a real database.
 *
 * `one_active_draft_per_number` is a partial unique index, so it is invisible
 * to the pure tests: `validateDraft` is correct, the SQL is correct, and the
 * collision only exists between them.
 *
 * The office found it before this test did. Numbering a draft threw the raw
 * Postgres error, which the API answered as "Something went wrong. Try again."
 * — advice that cannot work, so it was tried five times in ten seconds, and
 * the conclusion drawn was that the system had no concept of FMR numbering at
 * all. A rule the database enforces has to be a rule a person can read.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { enabled, connect, close, fixture } from './harness.js';

const skip = enabled ? false : 'set FMR_TEST_DATABASE_URL to run';

const draft = (over = {}) => ({
  header: {
    fmrNumber: 'FMR-500', isoNumber: 'D-4410', isoSheet: '01',
    requestedBy: 'Dale Hughes', ...over.header
  },
  lines: over.lines ?? [
    { commodityCode: 'PF-A106', size: '6"', description: 'PIPE, CS A106 GR B',
      quantity: '120', uom: 'FT' }
  ]
});

test('drafts', { skip }, async (t) => {
  const { drafts } = await connect();
  t.after(close);

  await t.test('numbering a draft onto a number already waiting is explained, not crashed',
    async () => {
      const f = await fixture();
      await drafts.createDraft(f.ctx, draft());
      const second = await drafts.createDraft(f.ctx, draft({ header: { fmrNumber: null } }));

      // What the office did: opened the unnumbered draft and typed the number
      // of one already in the queue.
      const failure = await drafts.updateDraftHeader(f.ctx, {
        itemId: second.itemId, patch: { fmrNumber: 'FMR-500' }
      }).then(() => null, (error) => error);

      assert.ok(failure, 'a second draft took a number that was already waiting');
      assert.equal(failure.name, 'LedgerError',
        `a raw ${failure.name} reaches the office as "try again"`);
      assert.equal(failure.code, 'NUMBER_IN_USE');
      assert.match(failure.message, /FMR-500/,
        'the message has to name the number that collided');
      assert.match(failure.message, /archive|publish|different number/i,
        'and say what to do about it');
    });

  await t.test('creating a second draft under a waiting number is explained too', async () => {
    const f = await fixture();
    await drafts.createDraft(f.ctx, draft());

    const failure = await drafts.createDraft(f.ctx, draft())
      .then(() => null, (error) => error);

    assert.ok(failure, 'two drafts shared one number');
    assert.equal(failure.name, 'LedgerError');
    assert.equal(failure.code, 'NUMBER_IN_USE');
  });

  await t.test('the same number is free again once the draft is archived', async () => {
    // The index is partial — archived and published drafts leave their number
    // behind. Re-numbering has to keep working, or the message above is a wall.
    const f = await fixture();
    const first = await drafts.createDraft(f.ctx, draft());
    await drafts.archiveDraft(f.ctx, { batchId: first.batchId, reason: 'superseded by a revision' });

    const second = await drafts.createDraft(f.ctx, draft({ header: { fmrNumber: null } }));
    const ok = await drafts.updateDraftHeader(f.ctx, {
      itemId: second.itemId, patch: { fmrNumber: 'FMR-500' }
    });
    assert.equal(ok.ok, true);
  });

  await t.test('a draft can still be renamed to a number nobody holds', async () => {
    const f = await fixture();
    const only = await drafts.createDraft(f.ctx, draft());
    const ok = await drafts.updateDraftHeader(f.ctx, {
      itemId: only.itemId, patch: { fmrNumber: 'FMR-777' }
    });
    assert.equal(ok.ok, true);
  });
});
