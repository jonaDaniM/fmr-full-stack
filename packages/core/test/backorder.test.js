import test from 'node:test';
import assert from 'node:assert/strict';
import { lineState, BACKORDER_DECISIONS, LedgerError } from '../src/domain/ledger.js';
import {
  planLocationTransitions, applyLocationTransitions, planAdminDecision, BACKORDER_STATUS
} from '../src/domain/backorder.js';

const state = (over = {}) => lineState({
  qty_requested: 100, qty_confirmed_located: 0, qty_active_bagged: 0,
  qty_available: 0, qty_issued: 0, qty_pending_backorder: 0,
  qty_confirmed_backorder: 0, ...over
});

const req = (over = {}) => ({
  id: 'r1', status: BACKORDER_STATUS.PENDING, qty_requested: 20,
  qty_confirmed: 0, qty_pending: 20, reported_at: '2026-01-01T00:00:00Z', ...over
});

test('locating nothing plans nothing', () => {
  const plan = planLocationTransitions(state(), [], 0);
  assert.equal(plan.confirmedConsumed, 0);
  assert.equal(plan.pendingConsumed, 0);
});

test('located material settles confirmed commitments first', () => {
  const s = state({ qty_confirmed_backorder: 20, qty_pending_backorder: 15 });
  const requests = [
    req({ id: 'c1', status: BACKORDER_STATUS.CONFIRMED, qty_confirmed: 20, qty_pending: 0 }),
    req({ id: 'p1', qty_pending: 15 })
  ];

  const plan = planLocationTransitions(s, requests, 25);
  assert.equal(plan.confirmedConsumed, 20, 'the promise is settled before the open ask');
  assert.equal(plan.pendingConsumed, 5);
  assert.equal(plan.confirmedSteps[0].requestId, 'c1');
  assert.equal(plan.pendingSteps[0].requestId, 'p1');
});

test('confirmed commitments are consumed oldest first', () => {
  const s = state({ qty_confirmed_backorder: 30 });
  const requests = [
    req({ id: 'newer', status: BACKORDER_STATUS.CONFIRMED, qty_confirmed: 20,
          qty_pending: 0, reported_at: '2026-06-01T00:00:00Z' }),
    req({ id: 'older', status: BACKORDER_STATUS.CONFIRMED, qty_confirmed: 10,
          qty_pending: 0, reported_at: '2026-01-01T00:00:00Z' })
  ];

  const plan = planLocationTransitions(s, requests, 15);
  assert.equal(plan.confirmedSteps[0].requestId, 'older');
  assert.equal(plan.confirmedSteps[0].quantity, 10);
  assert.equal(plan.confirmedSteps[1].requestId, 'newer');
  assert.equal(plan.confirmedSteps[1].quantity, 5);
});

test('a partially consumed request keeps its remainder', () => {
  const s = state({ qty_confirmed_backorder: 20 });
  const requests = [
    req({ id: 'c1', status: BACKORDER_STATUS.CONFIRMED, qty_confirmed: 20, qty_pending: 0 })
  ];
  const plan = planLocationTransitions(s, requests, 8);
  assert.equal(plan.confirmedSteps[0].quantity, 8);
  assert.equal(plan.confirmedSteps[0].remainingConfirmed, 12);
});

test('ledger totals that outrun their requests are refused', () => {
  const s = state({ qty_confirmed_backorder: 50 });
  const requests = [
    req({ id: 'c1', status: BACKORDER_STATUS.CONFIRMED, qty_confirmed: 10, qty_pending: 0 })
  ];
  assert.throws(() => planLocationTransitions(s, requests, 50), /needs reconciling/);
});

test('applying a plan draws down both backorder buckets', () => {
  const s = state({ qty_confirmed_backorder: 20, qty_pending_backorder: 15 });
  const plan = { confirmedConsumed: 20, pendingConsumed: 5, confirmedSteps: [], pendingSteps: [] };
  applyLocationTransitions(s, plan);
  assert.equal(s.confirmedBackorder, 0);
  assert.equal(s.pendingBackorder, 10);
});

test('full confirm commits the office to supplying it', () => {
  const plan = planAdminDecision(req(), BACKORDER_DECISIONS.CONFIRM, 20);
  assert.equal(plan.update.status, BACKORDER_STATUS.CONFIRMED);
  assert.equal(plan.update.qty_confirmed, 20);
  assert.equal(plan.update.qty_pending, 0);
  assert.equal(plan.ledger.pendingDelta, -20);
  assert.equal(plan.ledger.confirmedDelta, 20);
});

test('partial confirm leaves the rest pending', () => {
  const plan = planAdminDecision(req(), BACKORDER_DECISIONS.CONFIRM, 12);
  assert.equal(plan.update.status, BACKORDER_STATUS.PARTIALLY_CONFIRMED);
  assert.equal(plan.update.qty_confirmed, 12);
  assert.equal(plan.update.qty_pending, 8);
});

test('reject releases the lock and tells the field', () => {
  const plan = planAdminDecision(req(), BACKORDER_DECISIONS.REJECT, 20);
  assert.equal(plan.update.status, BACKORDER_STATUS.REJECTED);
  assert.equal(plan.ledger.pendingDelta, -20, 'the crew may now source it themselves');
  assert.equal(plan.ledger.confirmedDelta, 0);
  assert.equal(plan.notifyField.kind, 'REJECTED');
});

test('partial reject keeps the request alive for the remainder', () => {
  const plan = planAdminDecision(req({ qty_pending: 20 }), BACKORDER_DECISIONS.REJECT, 5);
  assert.equal(plan.update.qty_pending, 15);
  assert.equal(plan.update.active, true);
  assert.notEqual(plan.update.status, BACKORDER_STATUS.REJECTED);
});

test('full return sends it back without releasing the lock', () => {
  const plan = planAdminDecision(req(), BACKORDER_DECISIONS.RETURN, 20);
  assert.equal(plan.update.status, BACKORDER_STATUS.RETURNED);
  assert.equal(plan.ledger.pendingDelta, 0, 'still outstanding, still locked');
  assert.equal(plan.split, null, 'nothing to split when the whole request goes back');
  assert.equal(plan.notifyField.kind, 'RETURNED');
});

test('partial return splits the request in two', () => {
  const original = req({ qty_requested: 20, qty_pending: 20, qty_confirmed: 0 });
  const plan = planAdminDecision(original, BACKORDER_DECISIONS.RETURN, 8);
  assert.ok(plan.split, 'the returned part becomes its own request');
  assert.equal(plan.split.qty_requested, 8);
  assert.equal(plan.update.qty_pending, 12, 'the untouched remainder stays put');
});

test('a return against an already-confirmed request splits too', () => {
  const original = req({
    status: BACKORDER_STATUS.PARTIALLY_CONFIRMED, qty_requested: 20,
    qty_confirmed: 12, qty_pending: 8
  });
  const plan = planAdminDecision(original, BACKORDER_DECISIONS.RETURN, 8);
  assert.ok(plan.split);
  assert.equal(plan.split.qty_requested, 8);
});

test('decisions are validated', () => {
  assert.throws(() => planAdminDecision(req(), 'MAYBE', 5), /Unsupported backorder decision/);
  assert.throws(() => planAdminDecision(req(), BACKORDER_DECISIONS.CONFIRM, 99), /Only 20 is pending/);
  assert.throws(() => planAdminDecision(req(), BACKORDER_DECISIONS.CONFIRM, 0), /greater than zero/);
  assert.throws(
    () => planAdminDecision(req({ qty_pending: 0 }), BACKORDER_DECISIONS.CONFIRM, 5),
    /no pending quantity/
  );
});

test('omitting a quantity decides the whole pending amount', () => {
  const plan = planAdminDecision(req({ qty_pending: 17 }), BACKORDER_DECISIONS.CONFIRM);
  assert.equal(plan.quantity, 17);
  assert.equal(plan.update.status, BACKORDER_STATUS.CONFIRMED);
});
