import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeNotice, planNoticeResolution, NOTICE_KIND, NOTICE_SEVERITY, NOTICE_STATUS
} from '../src/domain/notices.js';

const notice = (over = {}) => ({
  id: 'n1', kind: NOTICE_KIND.REJECTED, status: NOTICE_STATUS.ACTIVE,
  qty_notified: 20, qty_resolved: 0, qty_outstanding: 20,
  raised_at: '2026-01-01T00:00:00Z', ...over
});

test('a rejection tells the crew to source it themselves', () => {
  const n = describeNotice('REJECT', { quantity: 30, uom: 'FT' });
  assert.equal(n.kind, NOTICE_KIND.REJECTED);
  assert.equal(n.severity, NOTICE_SEVERITY.CRITICAL);
  assert.match(n.headline, /30 FT rejected/);
  assert.match(n.detail, /will not be supplying/);
});

test("the office's own words are used when they gave any", () => {
  const n = describeNotice('REJECT', {
    quantity: 5, uom: 'EA', adminNotes: 'obsolete part, use the 316L equivalent'
  });
  assert.match(n.detail, /obsolete part/);
});

test('a return asks the crew for more detail', () => {
  const n = describeNotice('RETURN', { quantity: 8, uom: 'EA', adminNotes: 'which heat number?' });
  assert.equal(n.kind, NOTICE_KIND.RETURNED);
  assert.equal(n.severity, NOTICE_SEVERITY.WARNING);
  assert.equal(n.detail, 'which heat number?');
});

test('a full confirmation needs no notice — the line already shows it', () => {
  assert.equal(describeNotice('CONFIRM', { quantity: 20, fullyDecided: true }), null);
});

test('a partial confirmation does get one', () => {
  const n = describeNotice('CONFIRM', { quantity: 12, uom: 'EA', fullyDecided: false });
  assert.equal(n.kind, NOTICE_KIND.CONFIRMED);
  assert.equal(n.severity, NOTICE_SEVERITY.INFO);
  assert.match(n.headline, /12 EA confirmed/);
});

test('nothing is raised for a zero quantity', () => {
  assert.equal(describeNotice('REJECT', { quantity: 0 }), null);
});

test('locating material settles a rejection — that was the instruction', () => {
  const { steps, resolved } = planNoticeResolution([notice()], 'CONFIRM_AVAILABLE', 20);
  assert.equal(resolved, 20);
  assert.equal(steps[0].noticeId, 'n1');
  assert.ok(steps[0].fullyResolved);
});

test('partly settling a notice leaves the rest outstanding', () => {
  const { steps, resolved } = planNoticeResolution([notice()], 'DIRECT_ISSUE', 8);
  assert.equal(resolved, 8);
  assert.equal(steps[0].qtyResolved, 8);
  assert.equal(steps[0].fullyResolved, false);
});

test('notices settle oldest first', () => {
  const notices = [
    notice({ id: 'newer', raised_at: '2026-06-01T00:00:00Z', qty_outstanding: 10 }),
    notice({ id: 'older', raised_at: '2026-01-01T00:00:00Z', qty_outstanding: 10 })
  ];
  const { steps } = planNoticeResolution(notices, 'CONFIRM_AVAILABLE', 15);
  assert.equal(steps[0].noticeId, 'older');
  assert.equal(steps[0].quantity, 10);
  assert.equal(steps[1].noticeId, 'newer');
  assert.equal(steps[1].quantity, 5);
});

test('issuing from stock settles nothing — no instruction was answered', () => {
  const { resolved } = planNoticeResolution([notice()], 'ISSUE_FROM_AVAILABLE', 20);
  assert.equal(resolved, 0, 'the material was already on the shelf');
});

test('resubmitting a backorder answers a returned notice, not a rejection', () => {
  const returned = notice({ kind: NOTICE_KIND.RETURNED });
  assert.equal(planNoticeResolution([returned], 'BACKORDER_REQUESTED', 20).resolved, 20);
  assert.equal(planNoticeResolution([notice()], 'BACKORDER_REQUESTED', 20).resolved, 0);
});

test('locating does not answer a returned notice', () => {
  const returned = notice({ kind: NOTICE_KIND.RETURNED });
  assert.equal(planNoticeResolution([returned], 'CONFIRM_AVAILABLE', 20).resolved, 0,
    'the office asked a question; finding material does not answer it');
});

test('already-resolved notices are left alone', () => {
  const done = notice({ status: NOTICE_STATUS.RESOLVED, qty_outstanding: 0 });
  assert.equal(planNoticeResolution([done], 'CONFIRM_AVAILABLE', 20).resolved, 0);
});
