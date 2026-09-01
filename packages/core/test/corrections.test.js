import test from 'node:test';
import assert from 'node:assert/strict';
import { lineState, LedgerError, applyConfirmAvailable, applyDirectIssue } from '../src/domain/ledger.js';
import { planCorrection, validateCorrectedState, REVERSIBLE } from '../src/domain/corrections.js';

const state = (over = {}) => lineState({
  qty_requested: 100, qty_confirmed_located: 0, qty_active_bagged: 0,
  qty_available: 0, qty_issued: 0, qty_pending_backorder: 0,
  qty_confirmed_backorder: 0, ...over
});

const txn = (type, quantity, over = {}) => ({
  id: 1, transaction_type: type, quantity, uom: 'FT',
  created_at: '2026-01-01T00:00:00Z', ...over
});

test('a mis-keyed issue is undone by its opposite', () => {
  const s = state({ qty_confirmed_located: 100, qty_available: 0, qty_issued: 100 });
  const plan = planCorrection(s, [txn('DIRECT_ISSUE', 100)], { reason: 'typo: meant 10' });

  assert.equal(plan.after.issued, 0);
  assert.equal(plan.after.confirmed, 0);
  assert.equal(plan.after.remaining, 100);
  assert.equal(plan.status, 'Open');
});

test('the inverse entry is written, the original left alone', () => {
  const s = state({ qty_confirmed_located: 40, qty_available: 40 });
  const plan = planCorrection(s, [txn('CONFIRM_AVAILABLE', 40, { id: 77 })], { reason: 'wrong line' });

  assert.equal(plan.inverses.length, 1);
  assert.equal(plan.inverses[0].quantity, -40, 'the opposite amount');
  assert.equal(plan.inverses[0].transaction_type, 'CORRECTION_CONFIRM_AVAILABLE');
  assert.equal(plan.inverses[0].reversesTransactionId, '77', 'points back at what it corrects');
});

test('each transaction type reverses its own effect', () => {
  const cases = [
    ['CONFIRM_AVAILABLE', { qty_confirmed_located: 30, qty_available: 30 }, 30],
    ['ISSUE_FROM_AVAILABLE', { qty_confirmed_located: 30, qty_available: 10, qty_issued: 20 }, 20],
    ['ISSUE_FROM_BAG', { qty_confirmed_located: 30, qty_active_bagged: 10, qty_issued: 20 }, 20],
    ['BAG', { qty_confirmed_located: 30, qty_active_bagged: 30 }, 30],
    ['DIRECT_ISSUE', { qty_confirmed_located: 25, qty_issued: 25 }, 25]
  ];

  for (const [type, before, quantity] of cases) {
    const plan = planCorrection(state(before), [txn(type, quantity)], { reason: 'x' });
    assert.equal(
      plan.after.confirmed,
      plan.after.available + plan.after.bagged + plan.after.issued,
      `${type} left the ledger unbalanced`
    );
  }
});

test('a backorder request can be withdrawn', () => {
  const s = state({ qty_pending_backorder: 25 });
  const plan = planCorrection(s, [txn('BACKORDER_REQUESTED', 25)], { reason: 'raised in error' });
  assert.equal(plan.after.pendingBackorder, 0);
});

test('several transactions unwind newest first', () => {
  const s = state({ qty_confirmed_located: 50, qty_available: 30, qty_issued: 20 });
  const plan = planCorrection(s, [
    txn('CONFIRM_AVAILABLE', 50, { id: 1, created_at: '2026-01-01T00:00:00Z' }),
    txn('ISSUE_FROM_AVAILABLE', 20, { id: 2, created_at: '2026-01-02T00:00:00Z' })
  ], { reason: 'wrong FMR entirely' });

  assert.equal(plan.after.issued, 0);
  assert.equal(plan.after.available, 0);
  assert.equal(plan.after.confirmed, 0);
  assert.equal(plan.inverses[0].reversesTransactionId, '2', 'the later one is undone first');
});

test('a correction that would break the ledger is refused', () => {
  // Only 10 was issued; reversing 50 would go negative.
  const s = state({ qty_confirmed_located: 10, qty_issued: 10 });
  assert.throws(
    () => planCorrection(s, [txn('DIRECT_ISSUE', 50)], { reason: 'x' }),
    /would make .* negative|unaccounted for/
  );
});

test('a correction leaving material unaccounted for is refused', () => {
  assert.throws(() => validateCorrectedState({
    requested: 100, confirmed: 50, available: 10, bagged: 10, issued: 10,
    pendingBackorder: 0, confirmedBackorder: 0, notYetLocated: 50, remaining: 90
  }), /unaccounted for/);
});

test('a reason is required — a correction without one is not auditable', () => {
  const s = state({ qty_confirmed_located: 10, qty_available: 10 });
  assert.throws(() => planCorrection(s, [txn('CONFIRM_AVAILABLE', 10)], { reason: '' }),
    /needs a reason/);
  assert.throws(() => planCorrection(s, [txn('CONFIRM_AVAILABLE', 10)], { reason: '   ' }),
    /needs a reason/);
});

test('unknown transaction types are refused rather than guessed at', () => {
  assert.throws(
    () => planCorrection(state(), [txn('SOMETHING_ELSE', 5)], { reason: 'x' }),
    /Cannot reverse: SOMETHING_ELSE/
  );
});

test('correcting nothing is refused', () => {
  assert.throws(() => planCorrection(state(), [], { reason: 'x' }), /nothing to correct/i);
});

test('the before state is kept so the change can be audited', () => {
  const s = state({ qty_confirmed_located: 40, qty_available: 40 });
  const plan = planCorrection(s, [txn('CONFIRM_AVAILABLE', 40)], { reason: 'miscount' });

  assert.equal(plan.before.confirmed, 40, 'what it was');
  assert.equal(plan.after.confirmed, 0, 'what it became');
  assert.equal(plan.reason, 'miscount');
});

test('a correction round-trips a real sequence of actions', () => {
  const s = state();
  applyConfirmAvailable(s, 60);
  applyDirectIssue(s, 20);

  const snapshot = { ...s };
  const plan = planCorrection(s, [txn('DIRECT_ISSUE', 20, { id: 9 })], { reason: 'wrong crew' });

  assert.equal(plan.after.issued, 0);
  assert.equal(plan.after.confirmed, snapshot.confirmed - 20);
  assert.equal(plan.after.available, snapshot.available);
});

test('every reversible type is one the ledger can produce', () => {
  for (const type of REVERSIBLE) {
    assert.ok(type === type.toUpperCase(), `${type} should be upper case`);
  }
  assert.equal(REVERSIBLE.length, 6, 'the six field actions');
});
