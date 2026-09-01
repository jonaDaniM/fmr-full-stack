/**
 * Re-raising a backorder the office returned.
 *
 * A return means "tell us more". Raising it again is the crew's answer, so it
 * should revive that request — not open a second one beside it, which would
 * double the requirement and give the office two things to decide.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { planReturnedResubmission, BACKORDER_STATUS } from '../src/domain/backorder.js';

const req = (over = {}) => ({
  id: 'r1', status: BACKORDER_STATUS.RETURNED, qty_requested: 20,
  qty_confirmed: 0, qty_pending: 20, reported_at: '2026-01-01T00:00:00Z', ...over
});

test('with nothing returned, the whole quantity is new', () => {
  const plan = planReturnedResubmission([], 30);
  assert.equal(plan.absorbed, 0);
  assert.equal(plan.remainder, 30);
  assert.deepEqual(plan.steps, []);
});

test('a matching resubmission revives the returned request', () => {
  const plan = planReturnedResubmission([req()], 20);
  assert.equal(plan.absorbed, 20);
  assert.equal(plan.remainder, 0, 'nothing new is opened');
  assert.equal(plan.steps[0].requestId, 'r1');
  assert.ok(plan.steps[0].revives, 'it goes back to the office as a fresh ask');
});

test('a partial answer leaves the rest still returned', () => {
  const plan = planReturnedResubmission([req()], 8);
  assert.equal(plan.absorbed, 8);
  assert.equal(plan.remainder, 0);
  assert.equal(plan.steps[0].remainingReturned, 12);
  assert.equal(plan.steps[0].revives, false, 'still waiting on the rest');
});

test('more than was returned opens a new request for the excess', () => {
  const plan = planReturnedResubmission([req()], 35);
  assert.equal(plan.absorbed, 20);
  assert.equal(plan.remainder, 15, 'the extra becomes its own request');
});

test('returned requests are answered oldest first', () => {
  const requests = [
    req({ id: 'newer', reported_at: '2026-06-01T00:00:00Z', qty_pending: 10 }),
    req({ id: 'older', reported_at: '2026-01-01T00:00:00Z', qty_pending: 10 })
  ];
  const plan = planReturnedResubmission(requests, 15);
  assert.equal(plan.steps[0].requestId, 'older');
  assert.equal(plan.steps[0].applied, 10);
  assert.equal(plan.steps[1].requestId, 'newer');
  assert.equal(plan.steps[1].applied, 5);
});

test('pending and confirmed requests are left alone', () => {
  const requests = [
    req({ id: 'p', status: BACKORDER_STATUS.PENDING }),
    req({ id: 'c', status: BACKORDER_STATUS.CONFIRMED, qty_confirmed: 20, qty_pending: 0 })
  ];
  const plan = planReturnedResubmission(requests, 20);
  assert.equal(plan.absorbed, 0, 'only returned requests are answered');
  assert.equal(plan.remainder, 20);
});

test('a zero or negative quantity plans nothing', () => {
  assert.equal(planReturnedResubmission([req()], 0).absorbed, 0);
  assert.equal(planReturnedResubmission([req()], -5).absorbed, 0);
});
