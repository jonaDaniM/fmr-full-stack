/**
 * Administration guards.
 *
 * These are the rules that stop a project becoming unusable. FMRv3 enforced
 * two of them in the browser only, so they held for anyone using the screen
 * and not for anyone calling the API. Here they are checked in the service,
 * which is why they can be tested without a database.
 *
 * The service functions themselves need a connection, so what is exercised
 * here is the validation that runs before any query — the part that decides
 * whether a request is even coherent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { LedgerError } from '../src/domain/ledger.js';
import { saveMember, setMemberActive, renumberFmr } from '../src/services/admin.js';

const ctx = (over = {}) => ({
  user: { id: 'u1', email: 'owner@example.com', display_name: 'Owner' },
  projectId: 'p1',
  ...over
});

/** These reject before touching the database, so no connection is needed. */
const rejects = (promise, pattern) => assert.rejects(promise, pattern);

test('a member needs a valid Google address', async () => {
  await rejects(
    saveMember(ctx(), { email: 'not-an-address', name: 'X', profile: 'FIELD' }),
    /valid Google account email/
  );
  await rejects(
    saveMember(ctx(), { email: '', name: 'X', profile: 'FIELD' }),
    /valid Google account email/
  );
});

test('a member needs a name', async () => {
  await rejects(
    saveMember(ctx(), { email: 'rita@example.com', name: '   ', profile: 'FIELD' }),
    /name is required/
  );
});

test('an unknown role is refused rather than guessed at', async () => {
  await rejects(
    saveMember(ctx(), { email: 'rita@example.com', name: 'Rita', profile: 'SUPERVISOR' }),
    /must be one of/
  );
});

test('nobody can deactivate their own account', async () => {
  // FMRv3 had no such guard: an owner could lock themselves out as long as
  // one other owner remained.
  await rejects(
    setMemberActive(ctx(), { userId: 'u1', active: false, reason: 'left the company' }),
    /cannot deactivate your own account/
  );
});

test('deactivating someone needs a reason', async () => {
  await rejects(
    setMemberActive(ctx(), { userId: 'u2', active: false }),
    /needs a reason/
  );
  await rejects(
    setMemberActive(ctx(), { userId: 'u2', active: false, reason: 'no' }),
    /at least 3 characters/
  );
});

test('reactivating needs no reason — nothing is being taken away', async () => {
  // Reaches the database, so a connection error means the guards let it past.
  await assert.rejects(
    setMemberActive(ctx(), { userId: 'u2', active: true }),
    (error) => !/reason|own account/.test(error.message)
  );
});

test('renumbering needs a target, a number and a reason', async () => {
  await rejects(renumberFmr(ctx(), { newNumber: 'FMR-2', reason: 'keyed wrong' }),
    /Which FMR/);
  await rejects(renumberFmr(ctx(), { fmrId: 'f1', reason: 'keyed wrong' }),
    /new FMR number is required/);
  await rejects(renumberFmr(ctx(), { fmrId: 'f1', newNumber: 'FMR-2' }),
    /needs a reason/);
  await rejects(renumberFmr(ctx(), { fmrId: 'f1', newNumber: 'FMR-2', reason: 'x' }),
    /at least 3 characters/);
});

test('guards raise LedgerError, so the API answers 422 rather than 500', async () => {
  await assert.rejects(
    saveMember(ctx(), { email: 'bad', name: 'X', profile: 'FIELD' }),
    (error) => {
      assert.ok(error instanceof LedgerError);
      assert.equal(error.code, 'BAD_EMAIL');
      return true;
    }
  );
});

// --- field text limits -----------------------------------------------------

test('free-text fields are capped before they reach the database', async () => {
  const { performFieldAction, TEXT_LIMITS } = await import('../src/services/field.js');

  const tooLong = (field, limit) => performFieldAction(
    { user: { id: 'u1', email: 'a@b.com' }, projectId: 'p1' },
    { action: 'CONFIRM_AVAILABLE', lineId: 'l1', quantity: 1, [field]: 'x'.repeat(limit + 1) }
  );

  await assert.rejects(tooLong('storageLocation', TEXT_LIMITS.storageLocation),
    /Storage location is too long/);
  await assert.rejects(tooLong('notes', TEXT_LIMITS.notes), /Notes is too long/);
  await assert.rejects(tooLong('issuedToName', TEXT_LIMITS.issuedToName),
    /Issued-to name is too long/);
  await assert.rejects(tooLong('bagTagNumber', TEXT_LIMITS.bagTagNumber),
    /Bag tag number is too long/);
});

test('a value exactly at the limit is accepted', async () => {
  const { performFieldAction, TEXT_LIMITS } = await import('../src/services/field.js');

  // Reaches the database, so a connection error means the cap let it through.
  await assert.rejects(
    performFieldAction(
      { user: { id: 'u1', email: 'a@b.com' }, projectId: 'p1' },
      {
        action: 'CONFIRM_AVAILABLE', lineId: 'l1', quantity: 1,
        storageLocation: 'x'.repeat(TEXT_LIMITS.storageLocation)
      }
    ),
    (error) => !/too long/.test(error.message)
  );
});
