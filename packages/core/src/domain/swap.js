/**
 * Line swap: borrowing material from another line.
 *
 * When one line is short and another has the exact material on the shelf, the
 * field borrows it to keep working. That already happens; what is missing is
 * the record. This turns it into two facts kept deliberately apart:
 *
 *   the physical movement   — material leaves the donor, reaches the receiver
 *   the replenishment debt  — the donor is owed that material back
 *
 * Keeping them separate is the whole point. Collapsing them into one number
 * loses the question everyone actually asks later: who is still owed what.
 *
 * The rule that governs the donor side:
 *
 *   material leaving the donor reduces BOTH its located and its available
 *   total, and never touches qty_requested
 *
 * So the donor's requirement stays exactly as large as it was, and the line
 * reads as short again the moment the material walks away. A donor must never
 * gain credit for fulfilling its own requirement by giving material to
 * somebody else — that is the failure this feature exists to prevent.
 *
 * Pure, like the rest of domain/. No database import.
 */

import { LedgerError } from './ledger.js';

export const SWAP_STATUS = Object.freeze({
  OPEN: 'Open',
  PARTIALLY_REPAID: 'Partially Repaid',
  REPAID: 'Repaid',
  CANCELLED: 'Cancelled'
});

const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Normalise a match key: absent and blank are the same thing, case is not. */
const key = (value) => String(value ?? '').trim().toUpperCase();

/**
 * How much a donor line can lend.
 *
 * Only what is sitting on the shelf, unreserved. Bagged material is already
 * promised to a crew under a bag tag, and issued material is gone — neither
 * is inventory anybody may casually reassign. This is Jonathan's "reserved or
 * bagged material does not become casually borrowable inventory".
 */
export function lendableQuantity(state) {
  return Math.max(0, num(state.available));
}

/**
 * Is this donor line made of the same material as the line that needs it?
 *
 * Commodity code, size and unit of measure must all agree. Commodity code is
 * the authority — it is what the warehouse orders against — so a line with no
 * commodity code can never be matched automatically. Guessing from a
 * description is how the wrong steel reaches a weld.
 */
export function isCompatible(donor, receiver) {
  const code = key(donor.commodity_code);
  if (!code) return false;
  if (code !== key(receiver.commodity_code)) return false;
  if (key(donor.size) !== key(receiver.size)) return false;
  if (key(donor.uom) !== key(receiver.uom)) return false;
  return true;
}

/** Why a candidate was refused, for a screen that has to explain itself. */
export function incompatibilityReason(donor, receiver) {
  if (!key(donor.commodity_code)) return 'no commodity code to match on';
  if (key(donor.commodity_code) !== key(receiver.commodity_code)) {
    return 'a different commodity code';
  }
  if (key(donor.size) !== key(receiver.size)) return 'a different size';
  if (key(donor.uom) !== key(receiver.uom)) return 'a different unit of measure';
  return null;
}

/**
 * Check a proposed borrow before anything moves.
 *
 * Returns the quantity to move. Throws with a message a foreman can act on.
 */
export function planSwap({ donor, donorState, receiver, receiverState, quantity }) {
  const qty = num(quantity);
  if (qty <= 0) throw new LedgerError('Borrow quantity must be greater than zero.');

  if (donor.id === receiver.id) {
    throw new LedgerError('A line cannot borrow from itself.', 'SAME_LINE');
  }

  if (!isCompatible(donor, receiver)) {
    const why = incompatibilityReason(donor, receiver);
    throw new LedgerError(
      `That line holds ${why}. Material can only be borrowed when the commodity `
      + 'code, size and unit of measure all match.',
      'INCOMPATIBLE'
    );
  }

  const lendable = lendableQuantity(donorState);
  if (lendable <= 0) {
    throw new LedgerError(
      `${donor.fmr_number} line ${donor.line_number} has nothing on the shelf to lend. `
      + 'Bagged and issued material cannot be borrowed.',
      'NOTHING_TO_LEND'
    );
  }
  if (qty > lendable) {
    throw new LedgerError(
      `Only ${lendable} can be borrowed from ${donor.fmr_number} line `
      + `${donor.line_number} — the rest is bagged or already issued.`,
      'LIMIT_EXCEEDED'
    );
  }

  // The receiver cannot take more than it still needs. Borrowing beyond the
  // requirement would leave material nobody is accountable for.
  const stillNeeded = Math.max(0, num(receiverState.remaining) - num(receiverState.available)
    - num(receiverState.bagged));
  if (stillNeeded <= 0) {
    throw new LedgerError(
      'This line already has everything it still needs. Nothing to borrow.',
      'NOT_SHORT'
    );
  }
  if (qty > stillNeeded) {
    throw new LedgerError(
      `This line is only short ${stillNeeded}. Borrow that or less.`,
      'LIMIT_EXCEEDED'
    );
  }

  return qty;
}

/**
 * Material leaves the donor.
 *
 * Both located and available fall. qty_requested is untouched, so the donor's
 * shortfall reappears immediately and the line stops looking satisfied.
 */
export function applyLend(state, quantity) {
  const qty = num(quantity);
  if (qty <= 0) throw new LedgerError('Borrow quantity must be greater than zero.');
  if (qty > lendableQuantity(state)) {
    throw new LedgerError(`Only ${lendableQuantity(state)} is on the shelf to lend.`,
      'LIMIT_EXCEEDED');
  }

  state.confirmed -= qty;
  state.available -= qty;
  state.notYetLocated = Math.max(0, state.requested - state.confirmed);
  state.remaining = Math.max(0, state.requested - state.issued);
  return state;
}

/**
 * Material reaches the receiver, and goes straight to the crew.
 *
 * It never rests on the receiver's shelf — somebody carried it over because
 * work was waiting on it. Same movement as a direct issue, which is why it
 * lands in located and issued together.
 */
export function applyBorrow(state, quantity) {
  const qty = num(quantity);
  if (qty <= 0) throw new LedgerError('Borrow quantity must be greater than zero.');
  if (qty > Math.max(0, state.remaining)) {
    throw new LedgerError(
      `This line only needs ${Math.max(0, state.remaining)} more.`, 'LIMIT_EXCEEDED');
  }

  state.confirmed += qty;
  state.issued += qty;
  state.notYetLocated = Math.max(0, state.requested - state.confirmed);
  state.remaining = Math.max(0, state.requested - state.issued);
  return state;
}

/**
 * Repay a swap, fully or in part.
 *
 * Material arriving for the donor settles the debt before it settles anything
 * else. Returns the amount applied and the status the swap now carries.
 *
 * A swap is repaid against its own outstanding balance only. One delivery
 * satisfying several swaps must be applied to each in turn, each one reducing
 * a shared remaining quantity — the original Materials Tracker got this wrong
 * by letting one incoming quantity settle several debts at full value.
 */
export function planRepayment(swap, quantity) {
  const qty = num(quantity);
  if (qty <= 0) throw new LedgerError('Repaid quantity must be greater than zero.');

  if (swap.status === SWAP_STATUS.CANCELLED) {
    throw new LedgerError('This swap was cancelled and cannot be repaid.', 'CANCELLED');
  }

  const outstanding = Math.max(0, num(swap.qty_borrowed) - num(swap.qty_repaid));
  if (outstanding <= 0) {
    throw new LedgerError('This swap is already fully repaid.', 'ALREADY_REPAID');
  }
  if (qty > outstanding) {
    throw new LedgerError(
      `Only ${outstanding} is still owed on this swap.`, 'LIMIT_EXCEEDED');
  }

  const repaid = num(swap.qty_repaid) + qty;
  return {
    applied: qty,
    qtyRepaid: repaid,
    outstanding: Math.max(0, num(swap.qty_borrowed) - repaid),
    status: repaid >= num(swap.qty_borrowed)
      ? SWAP_STATUS.REPAID
      : SWAP_STATUS.PARTIALLY_REPAID
  };
}

/** How long an obligation has been open, in whole days. */
export function ageInDays(swap, now = new Date()) {
  const opened = new Date(swap.created_at ?? now);
  return Math.max(0, Math.floor((now - opened) / 86400000));
}
