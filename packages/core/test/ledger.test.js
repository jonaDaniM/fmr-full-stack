import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lineState, locatableQuantity, reservableQuantity, newBackorderQuantity,
  lineStatus, actionLimits, applyConfirmAvailable, applyBag, applyDirectIssue,
  applyIssueFromAvailable, applyIssueFromBag, applyBackorderRequest,
  LedgerError, ACTIONS
} from '../src/domain/ledger.js';

const line = (over = {}) => lineState({
  qty_requested: 100, qty_confirmed_located: 0, qty_active_bagged: 0,
  qty_available: 0, qty_issued: 0, qty_pending_backorder: 0,
  qty_confirmed_backorder: 0, ...over
});

test('fresh line derives not-yet-located and remaining', () => {
  const s = line();
  assert.equal(s.notYetLocated, 100);
  assert.equal(s.remaining, 100);
  assert.equal(lineStatus(s), 'Open');
});

test('confirm moves material into available', () => {
  const s = line();
  applyConfirmAvailable(s, 40);
  assert.equal(s.confirmed, 40);
  assert.equal(s.available, 40);
  assert.equal(s.notYetLocated, 60);
  assert.equal(s.remaining, 100, 'nothing issued yet');
  assert.equal(lineStatus(s), 'Partially Located');
});

test('pending backorder locks the quantity from being located', () => {
  const s = line({ qty_pending_backorder: 30 });
  assert.equal(locatableQuantity(s), 70);
  assert.throws(() => applyConfirmAvailable(s, 80), LedgerError);
  applyConfirmAvailable(s, 70);
  assert.equal(s.confirmed, 70);
});

test('bag locates and reserves in one step', () => {
  const s = line();
  const newlyLocated = applyBag(s, 25);
  assert.equal(newlyLocated, 25, 'nothing was available, so all 25 was newly found');
  assert.equal(s.bagged, 25);
  assert.equal(s.available, 0);
  assert.equal(s.confirmed, 25);
});

test('bag draws from available before locating more', () => {
  const s = line();
  applyConfirmAvailable(s, 30);
  const newlyLocated = applyBag(s, 50);
  assert.equal(newlyLocated, 20, '30 came off the shelf, 20 was newly found');
  assert.equal(s.available, 0);
  assert.equal(s.bagged, 50);
  assert.equal(s.confirmed, 50);
});

test('direct issue skips available entirely', () => {
  const s = line();
  applyDirectIssue(s, 60);
  assert.equal(s.issued, 60);
  assert.equal(s.available, 0);
  assert.equal(s.confirmed, 60);
  assert.equal(s.remaining, 40);
  assert.equal(lineStatus(s), 'Partially Issued');
});

test('issue from available draws down the shelf', () => {
  const s = line();
  applyConfirmAvailable(s, 50);
  applyIssueFromAvailable(s, 20);
  assert.equal(s.available, 30);
  assert.equal(s.issued, 20);
  assert.equal(s.confirmed, 50, 'still located, just moved on');
});

test('issue from available cannot exceed the shelf', () => {
  const s = line();
  applyConfirmAvailable(s, 10);
  assert.throws(() => applyIssueFromAvailable(s, 11), LedgerError);
});

test('issue from bag is capped by that specific bag', () => {
  const s = line();
  applyBag(s, 40);
  assert.throws(() => applyIssueFromBag(s, 30, 20), /remains available in this bag/);
  applyIssueFromBag(s, 20, 20);
  assert.equal(s.bagged, 20);
  assert.equal(s.issued, 20);
});

test('fully issued line reports Issued', () => {
  const s = line();
  applyDirectIssue(s, 100);
  assert.equal(s.remaining, 0);
  assert.equal(lineStatus(s), 'Issued');
});

test('backorder cannot duplicate an existing commitment', () => {
  const s = line({ qty_available: 30, qty_confirmed_located: 30 });
  assert.equal(newBackorderQuantity(s), 70);
  assert.throws(() => applyBackorderRequest(s, 71), LedgerError);
  applyBackorderRequest(s, 70);
  assert.equal(s.pendingBackorder, 70);
  assert.equal(lineStatus(s), 'Pending Backorder');
});

test('backorder accounts for bagged and already-confirmed backorders', () => {
  const s = line({
    qty_confirmed_located: 20, qty_active_bagged: 20,
    qty_confirmed_backorder: 30, qty_pending_backorder: 10
  });
  assert.equal(newBackorderQuantity(s), 40);
});

test('reservable is shelf plus what can still be found', () => {
  const s = line({ qty_confirmed_located: 20, qty_available: 20, qty_pending_backorder: 10 });
  assert.equal(locatableQuantity(s), 70);
  assert.equal(reservableQuantity(s), 90);
});

test('action limits reflect every rule at once', () => {
  const s = line({
    qty_confirmed_located: 30, qty_available: 30, qty_pending_backorder: 20
  });
  const limits = actionLimits(s);
  assert.equal(limits[ACTIONS.CONFIRM_AVAILABLE], 50);
  assert.equal(limits[ACTIONS.BAG], 80);
  assert.equal(limits[ACTIONS.DIRECT_ISSUE], 50);
  assert.equal(limits[ACTIONS.ISSUE_FROM_AVAILABLE], 30);
  assert.equal(limits[ACTIONS.BACKORDER_REQUESTED], 50);
});

test('quantities must be positive', () => {
  assert.throws(() => applyConfirmAvailable(line(), 0), /greater than zero/);
  assert.throws(() => applyBag(line(), -5), /greater than zero/);
});

test('located always equals available plus bagged plus issued', () => {
  const s = line();
  applyConfirmAvailable(s, 50);
  applyBag(s, 30);
  applyIssueFromAvailable(s, 10);
  applyDirectIssue(s, 15);
  assert.equal(s.confirmed, s.available + s.bagged + s.issued,
    'the schema enforces this too — keep them in step');
});
