/**
 * The quantity ledger for a single FMR line.
 *
 * Ported from FMRv3 (FieldService.gs / IntegrityService.gs). These functions
 * are pure: they take a state, return a new state, and touch nothing else.
 * Persistence and locking live in the service layer.
 *
 * State fields:
 *   requested          what the FMR asked for
 *   confirmed          located in stores (available + bagged + issued)
 *   bagged             reserved under a bag tag
 *   available          located, unreserved, ready to issue
 *   issued             handed over
 *   pendingBackorder   awaiting an admin decision
 *   confirmedBackorder admin committed to supplying it
 *   notYetLocated      requested - confirmed        (derived)
 *   remaining          requested - issued           (derived)
 */

export const ACTIONS = Object.freeze({
  CONFIRM_AVAILABLE: 'CONFIRM_AVAILABLE',
  BAG: 'BAG',
  DIRECT_ISSUE: 'DIRECT_ISSUE',
  ISSUE_FROM_AVAILABLE: 'ISSUE_FROM_AVAILABLE',
  ISSUE_FROM_BAG: 'ISSUE_FROM_BAG',
  BACKORDER_REQUESTED: 'BACKORDER_REQUESTED'
});

export const BACKORDER_DECISIONS = Object.freeze({
  CONFIRM: 'CONFIRM',
  REJECT: 'REJECT',
  RETURN: 'RETURN'
});

export class LedgerError extends Error {
  constructor(message, code = 'LEDGER_RULE') {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Build a working state from a persisted line row. */
export function lineState(line) {
  const requested = num(line.qty_requested);
  const confirmed = num(line.qty_confirmed_located);
  const issued = num(line.qty_issued);

  return {
    requested,
    confirmed,
    bagged: num(line.qty_active_bagged),
    available: num(line.qty_available),
    issued,
    pendingBackorder: num(line.qty_pending_backorder),
    confirmedBackorder: num(line.qty_confirmed_backorder),
    notYetLocated: Math.max(0, requested - confirmed),
    remaining: Math.max(0, requested - issued)
  };
}

/** Re-derive the two computed fields after a mutation. */
function rederive(state) {
  state.notYetLocated = Math.max(0, state.requested - state.confirmed);
  state.remaining = Math.max(0, state.requested - state.issued);
  return state;
}

/**
 * How much can still be newly located.
 *
 * Quantities sitting under a pending backorder are locked: someone has asked
 * the office to source them and is waiting on an answer. Locating them behind
 * that request's back would double-count the requirement.
 */
export function locatableQuantity(state) {
  return Math.max(
    0,
    Math.min(num(state.notYetLocated), num(state.remaining)) - num(state.pendingBackorder)
  );
}

/** How much can be reserved into a bag: what is on hand, plus what could still be found. */
export function reservableQuantity(state) {
  return Math.max(0, num(state.available) + locatableQuantity(state));
}

/** How much may be raised as a new backorder without duplicating a commitment. */
export function newBackorderQuantity(state) {
  return Math.max(
    0,
    num(state.remaining) -
      num(state.available) -
      num(state.bagged) -
      num(state.pendingBackorder) -
      num(state.confirmedBackorder)
  );
}

/** Status is always derived from quantities, never set by hand. */
export function lineStatus(state) {
  if (state.remaining <= 0 && state.requested > 0) return 'Issued';
  if (state.issued > 0) return 'Partially Issued';
  if (state.confirmedBackorder > 0) return 'Backordered';
  if (state.pendingBackorder > 0) return 'Pending Backorder';
  if (state.bagged >= state.requested && state.requested > 0) return 'Bagged';
  if (state.bagged > 0) return 'Partially Bagged';
  if (state.confirmed >= state.requested && state.requested > 0) return 'Located';
  if (state.confirmed > 0) return 'Partially Located';
  return 'Open';
}

/** The per-action ceilings the UI shows and the service layer enforces. */
export function actionLimits(state) {
  const locatable = locatableQuantity(state);
  return {
    [ACTIONS.CONFIRM_AVAILABLE]: locatable,
    [ACTIONS.BAG]: reservableQuantity(state),
    [ACTIONS.DIRECT_ISSUE]: Math.min(locatable, Math.max(0, state.remaining)),
    [ACTIONS.ISSUE_FROM_AVAILABLE]: Math.min(
      num(state.available),
      Math.max(0, state.remaining)
    ),
    [ACTIONS.BACKORDER_REQUESTED]: newBackorderQuantity(state)
  };
}

function requirePositive(quantity, label) {
  const parsed = num(quantity);
  if (parsed <= 0) throw new LedgerError(`${label} must be greater than zero.`);
  return parsed;
}

function requireWithin(quantity, maximum, message) {
  if (quantity > maximum) throw new LedgerError(message(maximum), 'LIMIT_EXCEEDED');
}

/**
 * Material found in stores and left on the shelf, unreserved.
 * notYetLocated -> confirmed + available
 */
export function applyConfirmAvailable(state, quantity) {
  const qty = requirePositive(quantity, 'Confirmed quantity');
  requireWithin(
    qty,
    locatableQuantity(state),
    (max) => `Only ${max} can be newly confirmed while pending backorders remain locked.`
  );

  state.confirmed += qty;
  state.available += qty;
  return rederive(state);
}

/**
 * Material reserved under a bag tag. May locate and reserve in one step:
 * anything beyond what is already available is newly located first.
 * Returns the newly located portion, which drives backorder fulfilment.
 */
export function applyBag(state, quantity) {
  const qty = requirePositive(quantity, 'Bag quantity');
  requireWithin(
    qty,
    reservableQuantity(state),
    (max) => `Only ${max} can be reserved while pending backorders remain locked.`
  );

  const newlyLocated = Math.max(0, qty - state.available);

  state.confirmed += newlyLocated;
  state.available += newlyLocated;
  state.available -= qty;
  state.bagged += qty;

  rederive(state);
  return newlyLocated;
}

/**
 * Located and handed over in one step, never resting in available.
 * notYetLocated -> confirmed + issued
 */
export function applyDirectIssue(state, quantity) {
  const qty = requirePositive(quantity, 'Issue quantity');
  requireWithin(
    qty,
    Math.min(locatableQuantity(state), Math.max(0, state.remaining)),
    (max) => `Only ${max} can be located and issued directly.`
  );

  state.confirmed += qty;
  state.issued += qty;
  return rederive(state);
}

/** available -> issued */
export function applyIssueFromAvailable(state, quantity) {
  const qty = requirePositive(quantity, 'Issue quantity');
  requireWithin(
    qty,
    Math.min(num(state.available), Math.max(0, state.remaining)),
    (max) => `Only ${max} is available to issue.`
  );

  state.available -= qty;
  state.issued += qty;
  return rederive(state);
}

/** bagged -> issued, drawn from one specific bag. */
export function applyIssueFromBag(state, quantity, bagRemaining) {
  const qty = requirePositive(quantity, 'Issue quantity');
  const ceiling = Math.min(
    num(state.bagged),
    Math.max(0, state.remaining),
    num(bagRemaining)
  );
  requireWithin(qty, ceiling, (max) => `Only ${max} remains available in this bag.`);

  state.bagged -= qty;
  state.issued += qty;
  return rederive(state);
}

/** Raise a backorder: locks the quantity until the office decides. */
export function applyBackorderRequest(state, quantity) {
  const qty = requirePositive(quantity, 'Backorder quantity');
  requireWithin(
    qty,
    newBackorderQuantity(state),
    (max) =>
      `Only ${max} can be submitted as a new backorder without duplicating an existing commitment.`
  );

  state.pendingBackorder += qty;
  return rederive(state);
}
