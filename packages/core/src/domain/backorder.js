/**
 * Backorder lifecycle.
 *
 * Two separate concerns live here:
 *
 *  1. When material is located, outstanding backorders for that line must be
 *     settled against it — oldest first. Otherwise the line would show both
 *     the material and an open request for the same material.
 *
 *  2. When the office reviews a request, it may confirm, reject, or return it,
 *     in whole or in part. A partial return splits the request in two.
 *
 * Ported from FMRv3 IntegrityService.gs and BackorderService.gs.
 */

import { BACKORDER_DECISIONS, LedgerError } from './ledger.js';

const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export const BACKORDER_STATUS = Object.freeze({
  PENDING: 'Pending',
  CONFIRMED: 'Confirmed',
  PARTIALLY_CONFIRMED: 'Partially Confirmed',
  REJECTED: 'Rejected',
  RETURNED: 'Returned for Review',
  FULFILLED: 'Fulfilled'
});

const CONSUMABLE = [BACKORDER_STATUS.CONFIRMED, BACKORDER_STATUS.PARTIALLY_CONFIRMED];

/**
 * Plan how newly located material settles outstanding backorders.
 *
 * Confirmed commitments are consumed first and oldest-first: the office
 * promised to source this material, and locating it fulfils that promise.
 * Pending requests are then reduced by whatever is left over, since the
 * material turned up before anyone had to decide.
 *
 * Pure — returns a plan, mutates nothing.
 */
export function planLocationTransitions(state, requests, newlyLocated) {
  const located = Math.max(0, num(newlyLocated));
  const plan = { confirmedSteps: [], pendingSteps: [], confirmedConsumed: 0, pendingConsumed: 0 };
  if (located <= 0) return plan;

  const ordered = [...requests].sort(
    (a, b) => new Date(a.reported_at) - new Date(b.reported_at)
  );

  // --- confirmed commitments, oldest first
  let confirmedBudget = Math.min(located, Math.max(0, num(state.confirmedBackorder)));

  const confirmedPool = ordered.filter(
    (r) => CONSUMABLE.includes(r.status) && num(r.qty_confirmed) > 0
  );
  const confirmedAvailable = confirmedPool.reduce((t, r) => t + num(r.qty_confirmed), 0);

  if (confirmedAvailable < confirmedBudget) {
    throw new LedgerError(
      'Confirmed backorder total does not match its open requests. ' +
        'The line needs reconciling before more material is recorded.',
      'BACKORDER_DESYNC'
    );
  }

  for (const request of confirmedPool) {
    if (confirmedBudget <= 0) break;
    const take = Math.min(confirmedBudget, num(request.qty_confirmed));
    if (take <= 0) continue;

    plan.confirmedSteps.push({
      requestId: request.id,
      quantity: take,
      remainingConfirmed: num(request.qty_confirmed) - take
    });
    confirmedBudget -= take;
    plan.confirmedConsumed += take;
  }

  // --- pending requests take whatever the located quantity did not spend
  let pendingBudget = Math.min(
    located - plan.confirmedConsumed,
    Math.max(0, num(state.pendingBackorder))
  );

  for (const request of ordered) {
    if (pendingBudget <= 0) break;
    if (request.status !== BACKORDER_STATUS.PENDING) continue;

    const take = Math.min(pendingBudget, num(request.qty_pending));
    if (take <= 0) continue;

    plan.pendingSteps.push({
      requestId: request.id,
      quantity: take,
      remainingPending: num(request.qty_pending) - take
    });
    pendingBudget -= take;
    plan.pendingConsumed += take;
  }

  return plan;
}

/** Apply a location plan to the working ledger state. */
export function applyLocationTransitions(state, plan) {
  state.confirmedBackorder = Math.max(0, state.confirmedBackorder - plan.confirmedConsumed);
  state.pendingBackorder = Math.max(0, state.pendingBackorder - plan.pendingConsumed);
  return state;
}

/**
 * Plan an admin decision on one request.
 *
 * CONFIRM  the office will supply it: pending -> confirmed.
 * REJECT   it will not be supplied: the quantity is released and the field
 *          crew is told, so they can locate it another way.
 * RETURN   the office needs more information. A partial return splits the
 *          request: the confirmed part stays put, the remainder becomes a new
 *          request pointing back at the original.
 *
 * Pure — returns a plan, mutates nothing.
 */
export function planAdminDecision(request, decision, quantity) {
  const pending = num(request.qty_pending);
  const alreadyConfirmed = num(request.qty_confirmed);

  if (!Object.values(BACKORDER_DECISIONS).includes(decision)) {
    throw new LedgerError(`Unsupported backorder decision: ${decision}`, 'BAD_DECISION');
  }
  if (pending <= 0) {
    throw new LedgerError('This request has no pending quantity left to decide.', 'NOT_PENDING');
  }

  const qty = quantity == null ? pending : num(quantity);
  if (qty <= 0) throw new LedgerError('Decision quantity must be greater than zero.');
  if (qty > pending) {
    throw new LedgerError(`Only ${pending} is pending on this request.`, 'LIMIT_EXCEEDED');
  }

  const remainder = pending - qty;

  if (decision === BACKORDER_DECISIONS.CONFIRM) {
    return {
      decision,
      quantity: qty,
      update: {
        qty_confirmed: alreadyConfirmed + qty,
        qty_pending: remainder,
        status: remainder > 0
          ? BACKORDER_STATUS.PARTIALLY_CONFIRMED
          : BACKORDER_STATUS.CONFIRMED
      },
      ledger: { pendingDelta: -qty, confirmedDelta: qty },
      split: null,
      notifyField: null
    };
  }

  if (decision === BACKORDER_DECISIONS.REJECT) {
    return {
      decision,
      quantity: qty,
      update: {
        qty_pending: remainder,
        status: remainder > 0 || alreadyConfirmed > 0
          ? request.status
          : BACKORDER_STATUS.REJECTED,
        active: remainder > 0 || alreadyConfirmed > 0
      },
      // Rejected material is no longer promised: release the lock so the
      // field crew can go and find it themselves.
      ledger: { pendingDelta: -qty, confirmedDelta: 0 },
      split: null,
      notifyField: { kind: 'REJECTED', quantity: qty }
    };
  }

  // RETURN
  const isPartial = alreadyConfirmed > 0 || remainder > 0;

  return {
    decision,
    quantity: qty,
    update: isPartial
      ? { qty_pending: remainder, status: request.status }
      : { qty_pending: qty, status: BACKORDER_STATUS.RETURNED },
    // A returned quantity is still outstanding — it stays locked.
    ledger: { pendingDelta: 0, confirmedDelta: 0 },
    split: isPartial ? { qty_requested: qty, qty_pending: qty } : null,
    notifyField: { kind: 'RETURNED', quantity: qty }
  };
}
