import test from 'node:test';
import assert from 'node:assert/strict';
import { lineState } from '../src/domain/ledger.js';
import {
  SWAP_STATUS, lendableQuantity, isCompatible, incompatibilityReason,
  planSwap, applyLend, applyBorrow, planRepayment, ageInDays
} from '../src/domain/swap.js';

const line = (over = {}) => ({
  id: over.id ?? 'donor',
  fmr_number: over.fmr_number ?? 'FMR-1001',
  line_number: over.line_number ?? 3,
  commodity_code: over.commodity_code ?? 'PP1234',
  size: over.size ?? '2',
  uom: over.uom ?? 'FT',
  ...over
});

const state = (over = {}) => lineState({
  qty_requested: 100, qty_confirmed_located: 0, qty_active_bagged: 0,
  qty_available: 0, qty_issued: 0, qty_pending_backorder: 0,
  qty_confirmed_backorder: 0, ...over
});

test('only material on the shelf can be lent', () => {
  // 40 located: 25 available, 10 bagged, 5 issued. Only the 25 is lendable.
  const s = state({
    qty_confirmed_located: 40, qty_available: 25, qty_active_bagged: 10, qty_issued: 5
  });
  assert.equal(lendableQuantity(s), 25);
});

test('bagged material is not borrowable inventory', () => {
  const s = state({ qty_confirmed_located: 30, qty_active_bagged: 30, qty_available: 0 });
  assert.equal(lendableQuantity(s), 0);
});

test('material matches only when code, size and unit all agree', () => {
  const receiver = line({ id: 'r' });
  assert.ok(isCompatible(line(), receiver));
  assert.ok(!isCompatible(line({ commodity_code: 'PP9999' }), receiver));
  assert.ok(!isCompatible(line({ size: '3' }), receiver));
  assert.ok(!isCompatible(line({ uom: 'EA' }), receiver));
});

test('a line with no commodity code is never matched automatically', () => {
  // Guessing from a description is how the wrong steel reaches a weld.
  assert.ok(!isCompatible(line({ commodity_code: null }), line({ id: 'r' })));
  assert.equal(
    incompatibilityReason(line({ commodity_code: '' }), line({ id: 'r' })),
    'no commodity code to match on'
  );
});

test('matching ignores case and surrounding space', () => {
  assert.ok(isCompatible(line({ commodity_code: ' pp1234 ' }), line({ id: 'r' })));
});

test('the reason a candidate was refused is specific', () => {
  const r = line({ id: 'r' });
  assert.equal(incompatibilityReason(line({ size: '6' }), r), 'a different size');
  assert.equal(incompatibilityReason(line({ uom: 'EA' }), r), 'a different unit of measure');
  assert.equal(incompatibilityReason(line(), r), null);
});

test('the donor keeps its full requirement after lending', () => {
  // This is the whole point of the feature: the donor must not gain credit
  // for satisfying its own requirement by giving material away.
  const donor = state({ qty_confirmed_located: 60, qty_available: 60 });
  applyLend(donor, 20);

  assert.equal(donor.requested, 100, 'requirement is untouched');
  assert.equal(donor.confirmed, 40);
  assert.equal(donor.available, 40);
  assert.equal(donor.notYetLocated, 60, 'the shortfall reappears immediately');
});

test('lending keeps located equal to available plus bagged plus issued', () => {
  const donor = state({
    qty_confirmed_located: 50, qty_available: 30, qty_active_bagged: 15, qty_issued: 5
  });
  applyLend(donor, 30);
  assert.equal(donor.confirmed, donor.available + donor.bagged + donor.issued);
});

test('a donor cannot lend what is bagged or issued', () => {
  const donor = state({
    qty_confirmed_located: 40, qty_available: 10, qty_active_bagged: 30
  });
  assert.throws(() => applyLend(donor, 25), /Only 10 is on the shelf/);
});

test('the receiver is credited as issued, never resting on its shelf', () => {
  // Somebody carried it over because work was waiting on it.
  const receiver = state({ qty_requested: 50 });
  applyBorrow(receiver, 20);

  assert.equal(receiver.issued, 20);
  assert.equal(receiver.available, 0, 'it went straight to the crew');
  assert.equal(receiver.confirmed, 20);
  assert.equal(receiver.remaining, 30);
});

test('borrowing keeps the receiver within its requirement', () => {
  const receiver = state({ qty_requested: 10 });
  assert.throws(() => applyBorrow(receiver, 15), /only needs 10 more/);
});

test('a line cannot borrow from itself', () => {
  const both = line({ id: 'same' });
  assert.throws(
    () => planSwap({
      donor: both, donorState: state({ qty_confirmed_located: 10, qty_available: 10 }),
      receiver: both, receiverState: state(), quantity: 5
    }),
    /cannot borrow from itself/
  );
});

test('borrowing is refused when the material does not match', () => {
  assert.throws(
    () => planSwap({
      donor: line({ commodity_code: 'XX1' }),
      donorState: state({ qty_confirmed_located: 10, qty_available: 10 }),
      receiver: line({ id: 'r' }), receiverState: state(), quantity: 5
    }),
    /different commodity code/
  );
});

test('borrowing is refused when the receiver is not short', () => {
  const receiver = state({ qty_requested: 20, qty_confirmed_located: 20, qty_available: 20 });
  assert.throws(
    () => planSwap({
      donor: line(), donorState: state({ qty_confirmed_located: 10, qty_available: 10 }),
      receiver: line({ id: 'r' }), receiverState: receiver, quantity: 5
    }),
    /already has everything it still needs/
  );
});

test('borrowing is capped at what the receiver is actually short', () => {
  const receiver = state({ qty_requested: 30, qty_confirmed_located: 25, qty_available: 25 });
  assert.throws(
    () => planSwap({
      donor: line(), donorState: state({ qty_confirmed_located: 50, qty_available: 50 }),
      receiver: line({ id: 'r' }), receiverState: receiver, quantity: 10
    }),
    /only short 5/
  );
});

test('a donor with an empty shelf is refused with a reason, not a limit', () => {
  assert.throws(
    () => planSwap({
      donor: line(), donorState: state({ qty_confirmed_located: 0 }),
      receiver: line({ id: 'r' }), receiverState: state(), quantity: 5
    }),
    /nothing on the shelf to lend/
  );
});

test('a valid borrow returns the quantity to move', () => {
  assert.equal(
    planSwap({
      donor: line(), donorState: state({ qty_confirmed_located: 40, qty_available: 40 }),
      receiver: line({ id: 'r' }), receiverState: state(), quantity: 25
    }),
    25
  );
});

test('a partial repayment leaves the swap open and owing', () => {
  const plan = planRepayment({ qty_borrowed: 100, qty_repaid: 0, status: SWAP_STATUS.OPEN }, 40);
  assert.equal(plan.applied, 40);
  assert.equal(plan.outstanding, 60);
  assert.equal(plan.status, SWAP_STATUS.PARTIALLY_REPAID);
});

test('repaying the balance closes the swap', () => {
  const plan = planRepayment(
    { qty_borrowed: 100, qty_repaid: 60, status: SWAP_STATUS.PARTIALLY_REPAID }, 40
  );
  assert.equal(plan.outstanding, 0);
  assert.equal(plan.status, SWAP_STATUS.REPAID);
});

test('a swap cannot be repaid beyond what is owed', () => {
  // One delivery must not settle several debts at full value.
  assert.throws(
    () => planRepayment({ qty_borrowed: 100, qty_repaid: 90, status: SWAP_STATUS.OPEN }, 20),
    /Only 10 is still owed/
  );
});

test('a settled swap refuses further repayment', () => {
  assert.throws(
    () => planRepayment({ qty_borrowed: 50, qty_repaid: 50, status: SWAP_STATUS.REPAID }, 5),
    /already fully repaid/
  );
});

test('a cancelled swap cannot be repaid', () => {
  assert.throws(
    () => planRepayment({ qty_borrowed: 50, qty_repaid: 0, status: SWAP_STATUS.CANCELLED }, 5),
    /was cancelled/
  );
});

test('a repayment must be a positive quantity', () => {
  const swap = { qty_borrowed: 50, qty_repaid: 0, status: SWAP_STATUS.OPEN };
  assert.throws(() => planRepayment(swap, 0), /greater than zero/);
  assert.throws(() => planRepayment(swap, -5), /greater than zero/);
});

test('an obligation reports how long it has been open', () => {
  const opened = new Date('2026-09-01T00:00:00Z');
  const now = new Date('2026-09-05T00:00:00Z');
  assert.equal(ageInDays({ created_at: opened }, now), 4);
});

test('material borrowed and lent nets to zero across both lines', () => {
  // Nothing is created or destroyed by a swap: it moves.
  const donor = state({ qty_confirmed_located: 80, qty_available: 80 });
  const receiver = state({ qty_requested: 60 });

  const beforeLocated = donor.confirmed + receiver.confirmed;
  applyLend(donor, 30);
  applyBorrow(receiver, 30);

  assert.equal(donor.confirmed + receiver.confirmed, beforeLocated);
  assert.equal(donor.confirmed, donor.available + donor.bagged + donor.issued);
  assert.equal(receiver.confirmed, receiver.available + receiver.bagged + receiver.issued);
});
