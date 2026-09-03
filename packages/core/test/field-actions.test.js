/**
 * A button the crew can see must be a button that can do something.
 *
 * The card decides which actions to offer by asking whether material of the
 * right kind exists — is anything not yet located, is anything on the shelf.
 * None of those questions notices a **pending backorder**, which locks
 * material without moving it out of any of those buckets.
 *
 * So a line whose whole outstanding quantity sat under a pending request still
 * offered Confirm found, Issue direct and Bag. Each one opened a quantity box
 * prefilled with 0, with a maximum of 0 and a minimum of 0.0001 — no number
 * could be entered, and Cancel was the only way out. Three buttons that looked
 * like work, on a card that was in fact waiting on the office.
 *
 * The ceiling is what knows this, so the ceiling is what filters the list.
 * These check the two halves of that: no dead button survives, and no useful
 * button is lost.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ceilingFor } from '../../web/public/lib/ceilings.js';

/** The card's own test for which actions suit a line, before the ceiling filter. */
function candidateActions(line) {
  const q = line.quantities;
  const actions = [];

  if (q.notYetLocated > 0 && q.remaining > 0) {
    actions.push('CONFIRM_AVAILABLE', 'DIRECT_ISSUE');
  }
  if (q.available > 0 || q.notYetLocated > 0) actions.push('BAG');
  if (q.available > 0 && q.remaining > 0) actions.push('ISSUE_FROM_AVAILABLE');
  if (line.activeBags?.length && q.remaining > 0) actions.push('ISSUE_FROM_BAG');
  if (q.remaining > q.available + q.bagged + q.pendingBackorder + q.confirmedBackorder) {
    actions.push('BACKORDER_REQUESTED');
  }
  return actions;
}

const offered = (line) => candidateActions(line).filter((a) => ceilingFor(line, a) > 0);

const line = (q, bags = []) => ({
  uom: 'FT',
  quantities: {
    requested: 0, available: 0, bagged: 0, issued: 0, remaining: 0,
    notYetLocated: 0, pendingBackorder: 0, confirmedBackorder: 0, ...q
  },
  activeBags: bags
});

test('a line waiting entirely on the office offers nothing to do', () => {
  // The whole 80 is under a pending request. Nothing can be located, reserved
  // or issued until the office answers.
  const waiting = line({
    requested: 80, remaining: 80, notYetLocated: 80, pendingBackorder: 80
  });

  assert.deepEqual(offered(waiting), [],
    'a line locked by a pending backorder must offer no actions');

  // The unfiltered list is what used to be rendered — kept here so the test
  // fails loudly if the filter is ever removed.
  assert.ok(candidateActions(waiting).length > 0,
    'this state must still be one the plain tests would have offered buttons for');
});

test('confirmed backorders do not lock the rest of a line', () => {
  // Confirmed means it is coming, but the material outside that commitment is
  // still the crew's to find — so the buttons stay.
  const partly = line({
    requested: 80, remaining: 80, notYetLocated: 80, confirmedBackorder: 80
  });
  assert.ok(offered(partly).includes('CONFIRM_AVAILABLE'));
});

test('a pending backorder only locks its own quantity', () => {
  const half = line({
    requested: 80, remaining: 80, notYetLocated: 80, pendingBackorder: 30
  });
  assert.ok(offered(half).includes('CONFIRM_AVAILABLE'));
  assert.equal(ceilingFor(half, 'CONFIRM_AVAILABLE'), 50);
});

test('no offered action ever opens a box that refuses every number', () => {
  // Sweep the reachable states rather than trusting examples: located material
  // is always available + bagged + issued, so the loops build only states the
  // schema would accept.
  let checked = 0;

  for (let requested = 0; requested <= 6; requested += 2) {
    for (let located = 0; located <= requested; located += 2) {
      for (let available = 0; available <= located; available += 2) {
        for (let bagged = 0; bagged <= located - available; bagged += 2) {
          const issued = located - available - bagged;
          for (let pending = 0; pending <= requested - located; pending += 2) {
            for (let confirmed = 0; confirmed <= requested - located - pending; confirmed += 2) {
              const state = line({
                requested,
                available,
                bagged,
                issued,
                remaining: requested - issued,
                notYetLocated: requested - located,
                pendingBackorder: pending,
                confirmedBackorder: confirmed
              }, bagged > 0 ? [{ bagTagId: 'b', qtyRemaining: bagged }] : []);

              for (const action of offered(state)) {
                checked++;
                assert.ok(ceilingFor(state, action) > 0,
                  `${action} offered with a ceiling of 0 on ${JSON.stringify(state.quantities)}`);
              }
            }
          }
        }
      }
    }
  }

  assert.ok(checked > 100, `expected a real sweep, only checked ${checked}`);
});

test('filtering never takes away an action that could have moved material', () => {
  // The other half of the guarantee: the filter must remove only dead buttons.
  for (let requested = 0; requested <= 6; requested += 2) {
    for (let located = 0; located <= requested; located += 2) {
      for (let available = 0; available <= located; available += 2) {
        for (let bagged = 0; bagged <= located - available; bagged += 2) {
          const issued = located - available - bagged;
          for (let pending = 0; pending <= requested - located; pending += 2) {
            const state = line({
              requested,
              available,
              bagged,
              issued,
              remaining: requested - issued,
              notYetLocated: requested - located,
              pendingBackorder: pending
            }, bagged > 0 ? [{ bagTagId: 'b', qtyRemaining: bagged }] : []);

            const kept = offered(state);
            for (const action of candidateActions(state)) {
              if (kept.includes(action)) continue;
              assert.equal(ceilingFor(state, action), 0,
                `${action} was removed but could have moved material`);
            }
          }
        }
      }
    }
  }
});
