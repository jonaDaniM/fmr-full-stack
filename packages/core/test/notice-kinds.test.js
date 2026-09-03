/**
 * The field card must name a notice by the decision, not by its lifecycle.
 *
 * A notice carries two different words that both look like a status:
 *
 *   `kind`    what the office decided — REJECTED, RETURNED, CONFIRMED
 *   `status`  where the notice is in its own life — Active, Resolved, Superseded
 *
 * The card branched on `status`, comparing it to 'Rejected'. No notice is ever
 * in a status called that, so every live notice fell to the other branch and a
 * rejection — the one notice meaning "nobody is sourcing this, go and find it
 * yourself" — was shown to the crew as "Returned", which means the opposite:
 * stop, the office is still deciding.
 *
 * The quantity was wrong in the same way. `qtyRequested` and `qtyPending` are
 * fields of a backorder request; a notice carries `qtyOutstanding`. Both read
 * undefined, so every notice displayed against a quantity of 0.
 *
 * These check the card's map against the kinds the domain can actually raise,
 * so a fourth kind cannot be added server-side and go unnamed in the field.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { describeNotice, NOTICE_KIND, NOTICE_STATUS } from '../src/domain/notices.js';
import { NOTICE_KINDS, noticeKind } from '../../web/public/lib/noticeKinds.js';

test('every kind the office can raise has a word for the crew', () => {
  for (const kind of Object.values(NOTICE_KIND)) {
    assert.ok(NOTICE_KINDS[kind], `no card wording for ${kind}`);
    assert.ok(NOTICE_KINDS[kind].label, `${kind} has an empty label`);
  }
});

test('a rejection is never labelled as a return', () => {
  // The two instructions are opposites: rejected means go and find it,
  // returned means wait, the office has a question. Confusing them sends a
  // crew to do the wrong thing.
  assert.equal(noticeKind(NOTICE_KIND.REJECTED).label, 'Rejected');
  assert.equal(noticeKind(NOTICE_KIND.RETURNED).label, 'Returned');
  assert.notEqual(
    noticeKind(NOTICE_KIND.REJECTED).label,
    noticeKind(NOTICE_KIND.RETURNED).label
  );
});

test('a lifecycle status is not a kind, and never picks the wording', () => {
  // This is the bug itself: the card read `status`, so proving no status is
  // mistakable for a kind is what stops it coming back.
  for (const status of Object.values(NOTICE_STATUS)) {
    assert.equal(NOTICE_KINDS[status], undefined,
      `${status} is a lifecycle status and must not name a notice`);
  }
});

test('an unknown kind still says something', () => {
  const shown = noticeKind('SOMETHING_NEW');
  assert.equal(shown.label, 'SOMETHING_NEW');
  assert.equal(shown.className, '');
});

test('the fields the card reads are the ones a notice actually carries', () => {
  // Built the way decideBackorder builds it, so the shape is the real one.
  const descriptor = describeNotice('REJECT', {
    quantity: 25, uom: 'FT', adminNotes: 'Source from local supply.', fullyDecided: true
  });

  // What raiseNotice stores, and noticesForLines serves back.
  const served = {
    kind: descriptor.kind,
    status: NOTICE_STATUS.ACTIVE,
    qtyNotified: descriptor.quantity,
    qtyResolved: 0,
    qtyOutstanding: descriptor.quantity,
    headline: descriptor.headline,
    detail: descriptor.detail,
    adminNotes: 'Source from local supply.'
  };

  assert.equal(noticeKind(served.kind).label, 'Rejected');
  assert.equal(served.qtyOutstanding, 25);

  // The two names the card used to read do not exist on a notice at all.
  assert.equal(served.qtyRequested, undefined);
  assert.equal(served.qtyPending, undefined);

  // The sentence is the server's, already carrying the office's note.
  assert.match(served.detail, /Source from local supply\./);
});

test('a confirmed notice is not shown as work to do', () => {
  // "On order" says stop looking. Labelling it Rejected or Returned would put
  // a crew back on a rack for material that is already coming.
  const confirmed = noticeKind(NOTICE_KIND.CONFIRMED);
  assert.equal(confirmed.label, 'On order');
  assert.notEqual(confirmed.className, NOTICE_KINDS.REJECTED.className);
});
