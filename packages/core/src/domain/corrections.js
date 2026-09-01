/**
 * Owner corrections.
 *
 * People mis-key quantities. Someone issues 100 feet instead of 10, and the
 * ledger is wrong until it is fixed.
 *
 * It is fixed by writing the opposite entry, never by editing what was
 * recorded. The original transaction stays exactly as it was — it is what
 * actually happened at the time, and an audit trail that can be rewritten is
 * not an audit trail. A correction adds inverse transactions and moves the
 * quantities back.
 *
 * Ported from FMRv3 OwnerCorrectionService.gs, which states the rule as
 * ORIGINAL_TRANSACTIONS_ARE_NEVER_DELETED_OR_EDITED.
 */

import { LedgerError, lineStatus } from './ledger.js';

const num = (v) => {
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Transaction types a correction knows how to reverse. */
export const REVERSIBLE = Object.freeze([
  'CONFIRM_AVAILABLE',
  'BAG',
  'DIRECT_ISSUE',
  'ISSUE_FROM_AVAILABLE',
  'ISSUE_FROM_BAG',
  'BACKORDER_REQUESTED'
]);

/**
 * Undo one transaction's effect on the ledger.
 *
 * Each is the exact mirror of the corresponding apply* in ledger.js.
 */
function reverseOne(state, transaction) {
  const amount = num(transaction.quantity);
  const type = String(transaction.transaction_type ?? '').toUpperCase();

  switch (type) {
    case 'CONFIRM_AVAILABLE':
      state.confirmed -= amount;
      state.available -= amount;
      break;

    case 'BAG':
      // Bagging may have located material on the way in. Put the reservation
      // back on the shelf; the caller reverses any location separately, since
      // that was recorded as its own CONFIRM_AVAILABLE transaction.
      state.bagged -= amount;
      state.available += amount;
      break;

    case 'DIRECT_ISSUE':
      state.confirmed -= amount;
      state.issued -= amount;
      break;

    case 'ISSUE_FROM_AVAILABLE':
      state.issued -= amount;
      state.available += amount;
      break;

    case 'ISSUE_FROM_BAG':
      state.issued -= amount;
      state.bagged += amount;
      break;

    case 'BACKORDER_REQUESTED':
      state.pendingBackorder -= amount;
      break;

    default:
      throw new LedgerError(`Cannot reverse a ${type} transaction.`, 'NOT_REVERSIBLE');
  }

  state.notYetLocated = Math.max(0, state.requested - state.confirmed);
  state.remaining = Math.max(0, state.requested - state.issued);
  return state;
}

/**
 * Check a corrected state is one the database would accept.
 *
 * A correction is the one place a person moves quantities directly, so it is
 * also the one place they could put a line into a state the constraints
 * forbid. Refuse before writing, with a message naming what would break.
 */
export function validateCorrectedState(state) {
  const eps = 1e-6;

  for (const field of ['requested', 'confirmed', 'bagged', 'available', 'issued',
                       'pendingBackorder', 'confirmedBackorder']) {
    if (num(state[field]) < -eps) {
      throw new LedgerError(
        `That correction would make ${field} negative.`, 'WOULD_BREAK'
      );
    }
  }

  if (state.confirmed > state.requested + eps) {
    throw new LedgerError('That correction would locate more than was requested.', 'WOULD_BREAK');
  }
  if (state.issued > state.requested + eps) {
    throw new LedgerError('That correction would issue more than was requested.', 'WOULD_BREAK');
  }

  // The schema's located_accounted_for constraint.
  const accounted = state.available + state.bagged + state.issued;
  if (Math.abs(state.confirmed - accounted) > eps) {
    throw new LedgerError(
      'That correction would leave located material unaccounted for ' +
      `(located ${state.confirmed}, but available + bagged + issued is ${accounted}).`,
      'WOULD_BREAK'
    );
  }

  if (state.pendingBackorder + state.confirmedBackorder > state.notYetLocated + eps) {
    throw new LedgerError(
      'That correction would leave more on backorder than is still to find.', 'WOULD_BREAK'
    );
  }

  return state;
}

/**
 * Plan a correction.
 *
 * Takes the state as it is and the transactions to reverse, and returns the
 * state that would result plus the inverse entries to write. Pure: nothing is
 * decided here that cannot be shown to the owner first.
 */
export function planCorrection(state, transactions, { reason }) {
  if (!reason || !String(reason).trim()) {
    throw new LedgerError('A correction needs a reason.', 'MISSING_REASON');
  }
  if (!transactions?.length) {
    throw new LedgerError('There is nothing to correct.', 'NOTHING_TO_DO');
  }

  const unsupported = transactions
    .map((t) => String(t.transaction_type ?? '').toUpperCase())
    .filter((type) => !REVERSIBLE.includes(type));

  if (unsupported.length) {
    throw new LedgerError(
      `Cannot reverse: ${[...new Set(unsupported)].join(', ')}.`, 'NOT_REVERSIBLE'
    );
  }

  const before = { ...state };
  const after = { ...state };

  // Reverse newest first, so a sequence unwinds the way it was built.
  const ordered = [...transactions].sort(
    (a, b) => new Date(b.created_at) - new Date(a.created_at)
  );

  for (const transaction of ordered) reverseOne(after, transaction);

  validateCorrectedState(after);

  return {
    before,
    after,
    status: lineStatus(after),
    inverses: ordered.map((t) => ({
      reversesTransactionId: String(t.id),
      transaction_type: `CORRECTION_${String(t.transaction_type).toUpperCase()}`,
      quantity: -num(t.quantity),
      uom: t.uom,
      sourceBagTagId: t.source_bag_tag_id ?? null,
      targetBagTagId: t.target_bag_tag_id ?? null,
      backorderRequestId: t.backorder_request_id ?? null
    })),
    reason: String(reason).trim(),
    types: [...new Set(ordered.map((t) => String(t.transaction_type).toUpperCase()))]
  };
}
