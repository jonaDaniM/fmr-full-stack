/**
 * The most a field action may move.
 *
 * A deliberate mirror of packages/core/src/domain/ledger.js, kept on the
 * client so the quantity box can carry a maximum and a crew is not asked to
 * guess. The server still decides; this only avoids sending someone up a
 * scaffold to be refused.
 *
 * It lives in its own file, with no DOM in it, so the test can import it and
 * check it against the real rule. `field-ceilings.test.js` runs both over the
 * same states — if they disagree, this file is what is wrong.
 */

export function ceilingFor(line, action) {
  const q = line.quantities;

  // Quantities under a pending backorder are locked: someone has asked the
  // office to source them and is waiting. Locating them behind that request's
  // back would double-count the requirement.
  const locatable = Math.max(0, Math.min(q.notYetLocated, q.remaining) - q.pendingBackorder);

  switch (action) {
    case 'CONFIRM_AVAILABLE': return locatable;
    case 'BAG': return q.available + locatable;
    case 'DIRECT_ISSUE': return Math.min(locatable, q.remaining);
    case 'ISSUE_FROM_AVAILABLE': return Math.min(q.available, q.remaining);
    case 'ISSUE_FROM_BAG': return Math.min(q.bagged, q.remaining);
    case 'BACKORDER_REQUESTED':
      return Math.max(0, q.remaining - q.available - q.bagged
        - q.pendingBackorder - q.confirmedBackorder);
    default: return 0;
  }
}
