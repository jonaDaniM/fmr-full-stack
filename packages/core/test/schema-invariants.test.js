/**
 * The schema encodes rules the ledger relies on. Postgres enforces them at
 * runtime; these tests check that the ledger never produces a state which
 * would violate them, so the two can never disagree.
 *
 * Mirrors 001_init.sql:
 *   located_accounted_for   located = available + bagged + issued
 *   issued_within_requested issued <= requested
 *   qty_not_yet_located     GREATEST(0, requested - located)
 *   qty_remaining_requirement GREATEST(0, requested - issued)
 *   every qty_* column      >= 0
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lineState, applyConfirmAvailable, applyBag, applyDirectIssue,
  applyIssueFromAvailable, applyIssueFromBag, applyBackorderRequest
} from '../src/domain/ledger.js';

/** Assert a state would survive every constraint in the fmr_lines table. */
function assertSchemaValid(s, context) {
  assert.equal(s.confirmed, s.available + s.bagged + s.issued,
    `located_accounted_for violated after ${context}`);
  assert.ok(s.issued <= s.requested,
    `issued_within_requested violated after ${context}`);
  assert.equal(s.notYetLocated, Math.max(0, s.requested - s.confirmed),
    `qty_not_yet_located mismatch after ${context}`);
  assert.equal(s.remaining, Math.max(0, s.requested - s.issued),
    `qty_remaining_requirement mismatch after ${context}`);

  for (const field of ['requested', 'confirmed', 'bagged', 'available', 'issued',
                       'pendingBackorder', 'confirmedBackorder']) {
    assert.ok(s[field] >= 0, `${field} went negative after ${context}`);
  }
}

const fresh = (requested = 100) => lineState({
  qty_requested: requested, qty_confirmed_located: 0, qty_active_bagged: 0,
  qty_available: 0, qty_issued: 0, qty_pending_backorder: 0, qty_confirmed_backorder: 0
});

test('each action alone leaves a schema-valid state', () => {
  let s = fresh(); applyConfirmAvailable(s, 40); assertSchemaValid(s, 'confirm');
  s = fresh(); applyBag(s, 40); assertSchemaValid(s, 'bag');
  s = fresh(); applyDirectIssue(s, 40); assertSchemaValid(s, 'direct issue');
  s = fresh(); applyBackorderRequest(s, 40); assertSchemaValid(s, 'backorder');

  s = fresh(); applyConfirmAvailable(s, 50); applyIssueFromAvailable(s, 20);
  assertSchemaValid(s, 'issue from available');

  s = fresh(); applyBag(s, 40); applyIssueFromBag(s, 15, 40);
  assertSchemaValid(s, 'issue from bag');
});

test('a long mixed sequence stays schema-valid throughout', () => {
  const s = fresh(200);
  const steps = [
    ['confirm 50', () => applyConfirmAvailable(s, 50)],
    ['bag 30', () => applyBag(s, 30)],
    ['issue 10 from available', () => applyIssueFromAvailable(s, 10)],
    ['direct issue 25', () => applyDirectIssue(s, 25)],
    ['issue 12 from bag', () => applyIssueFromBag(s, 12, 30)],
    ['backorder 20', () => applyBackorderRequest(s, 20)],
    ['confirm 15 more', () => applyConfirmAvailable(s, 15)],
    ['bag 8 more', () => applyBag(s, 8)]
  ];

  for (const [label, step] of steps) {
    step();
    assertSchemaValid(s, label);
  }

  assert.equal(s.confirmed, s.available + s.bagged + s.issued);
});

test('issuing everything lands exactly on the requested quantity', () => {
  const s = fresh(60);
  applyDirectIssue(s, 60);
  assertSchemaValid(s, 'full issue');
  assert.equal(s.issued, 60);
  assert.equal(s.remaining, 0);
});

test('rules refuse the states the schema would reject', () => {
  // issued_within_requested
  const s = fresh(50);
  assert.throws(() => applyDirectIssue(s, 51));

  // located_accounted_for: cannot issue material that is bagged, not available
  const t = fresh();
  applyBag(t, 40);
  assert.throws(() => applyIssueFromAvailable(t, 10), /available/);

  // no negative quantities
  const u = fresh();
  applyConfirmAvailable(u, 10);
  assert.throws(() => applyIssueFromAvailable(u, 20));
});

test('randomised sequences never break an invariant', () => {
  for (let run = 0; run < 400; run++) {
    const s = fresh(100);
    let bagOutstanding = 0;

    for (let step = 0; step < 12; step++) {
      const q = 1 + Math.floor(Math.random() * 20);
      const pick = Math.floor(Math.random() * 6);

      try {
        if (pick === 0) applyConfirmAvailable(s, q);
        else if (pick === 1) { bagOutstanding += applyBag(s, q) >= 0 ? q : 0; }
        else if (pick === 2) applyDirectIssue(s, q);
        else if (pick === 3) applyIssueFromAvailable(s, q);
        else if (pick === 4) {
          applyIssueFromBag(s, q, bagOutstanding);
          bagOutstanding -= q;
        }
        else applyBackorderRequest(s, q);
      } catch {
        // A refused action is the point: it means the rule held.
      }

      assertSchemaValid(s, `random run ${run} step ${step}`);
    }
  }
});
