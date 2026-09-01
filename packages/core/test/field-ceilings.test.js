/**
 * The field screen's quantity ceilings must agree with the ledger's.
 *
 * app.js carries `ceilingFor`, a deliberate copy of the domain rule, so the
 * quantity box can offer a maximum and a crew is not asked to guess. The
 * server still decides — but a client that offers a number the server then
 * refuses wastes a trip up a scaffold, so the two are checked here against the
 * same states.
 *
 * If this fails, the copy in app.js has drifted. Fix app.js, not the domain.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { actionLimits, lineState, ACTIONS } from '../src/domain/ledger.js';
import { ceilingFor } from '../../web/public/lib/ceilings.js';

/** Build a line row the way the database returns one. */
const line = (over = {}) => ({
  qty_requested: 100,
  qty_confirmed_located: 0,
  qty_available: 0,
  qty_active_bagged: 0,
  qty_issued: 0,
  qty_pending_backorder: 0,
  qty_confirmed_backorder: 0,
  ...over
});

// Every shape a line actually takes on site, including the awkward ones.
const CASES = [
  ['nothing found yet', line()],
  ['half located, on the shelf', line({ qty_confirmed_located: 50, qty_available: 50 })],
  ['some bagged', line({ qty_confirmed_located: 60, qty_available: 20, qty_active_bagged: 40 })],
  ['some issued', line({ qty_confirmed_located: 60, qty_available: 10, qty_issued: 50 })],
  ['fully issued', line({ qty_confirmed_located: 100, qty_issued: 100 })],
  ['pending backorder locks the rest', line({ qty_pending_backorder: 40 })],
  ['confirmed backorder outstanding', line({ qty_confirmed_backorder: 30 })],
  ['both backorder kinds', line({ qty_pending_backorder: 20, qty_confirmed_backorder: 25 })],
  ['located more than remaining', line({ qty_confirmed_located: 100, qty_available: 40, qty_issued: 60 })],
  ['backorder exceeds what is left', line({ qty_requested: 10, qty_pending_backorder: 40 })],
  ['fractional quantities', line({ qty_requested: 12.5, qty_confirmed_located: 6.25, qty_available: 6.25 })],
  ['zero requested', line({ qty_requested: 0 })]
];

// The five the client mirrors. ISSUE_FROM_BAG is not in actionLimits because
// its ceiling depends on the chosen bag's remaining quantity, which the domain
// takes as an argument rather than reading off the line.
const MIRRORED = [
  ACTIONS.CONFIRM_AVAILABLE,
  ACTIONS.BAG,
  ACTIONS.DIRECT_ISSUE,
  ACTIONS.ISSUE_FROM_AVAILABLE,
  ACTIONS.BACKORDER_REQUESTED
];

for (const [name, row] of CASES) {
  test(`the field screen offers the same ceilings as the ledger — ${name}`, () => {
    const state = lineState(row);
    const limits = actionLimits(state);

    for (const action of MIRRORED) {
      assert.equal(
        ceilingFor({ quantities: state }, action),
        limits[action],
        `${action} disagrees: field says ${ceilingFor({ quantities: state }, action)}, ` +
        `ledger says ${limits[action]}`
      );
    }
  });
}

test('the field screen never offers a negative quantity', () => {
  for (const [, row] of CASES) {
    const state = lineState(row);
    for (const action of [...MIRRORED, ACTIONS.ISSUE_FROM_BAG]) {
      assert.ok(
        ceilingFor({ quantities: state }, action) >= 0,
        `${action} offered a negative ceiling`
      );
    }
  }
});

test('an unknown action offers nothing rather than guessing', () => {
  assert.equal(ceilingFor({ quantities: lineState(line()) }, 'NOT_AN_ACTION'), 0);
});
