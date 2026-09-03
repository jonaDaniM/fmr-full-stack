/**
 * Field notices.
 *
 * A crew raises a backorder and then carries on working. When the office
 * decides, the crew needs to be told — on the line's own card, in the words
 * that tell them what to do next:
 *
 *   Rejected   nobody is sourcing this. Go and find it yourself.
 *   Returned   the office needs more from you before they will decide.
 *   Confirmed  it is on its way. Stop looking.
 *
 * A notice is not a log entry: it is outstanding work. It carries a quantity,
 * and it is resolved as the crew works through that quantity, not when they
 * dismiss it. Locating material against a rejected notice is what closes it.
 *
 * Ported from FMRv3 FieldBackorderNoticeService.gs.
 */

export const NOTICE_KIND = Object.freeze({
  REJECTED: 'REJECTED',
  RETURNED: 'RETURNED',
  CONFIRMED: 'CONFIRMED'
});

export const NOTICE_SEVERITY = Object.freeze({
  INFO: 'info',
  WARNING: 'warning',
  CRITICAL: 'critical'
});

export const NOTICE_STATUS = Object.freeze({
  ACTIVE: 'Active',
  RESOLVED: 'Resolved',
  SUPERSEDED: 'Superseded'
});

const num = (v) => {
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : 0;
};

const qty = (value, uom) => `${num(value).toLocaleString(undefined, {
  maximumFractionDigits: 2
})}${uom ? ` ${uom}` : ''}`;

/**
 * Describe the notice a decision should produce.
 *
 * Returns null when the decision needs no notice — a confirmation of the
 * whole request is good news the crew can read off the line's own quantities.
 */
export function describeNotice(decision, { quantity, uom, adminNotes, fullyDecided }) {
  const amount = num(quantity);
  if (amount <= 0) return null;

  switch (decision) {
    case 'REJECT':
      return {
        kind: NOTICE_KIND.REJECTED,
        severity: NOTICE_SEVERITY.CRITICAL,
        quantity: amount,
        headline: `${qty(amount, uom)} rejected — source it on site`,
        detail: adminNotes
          ? `The office will not be supplying this: ${adminNotes}`
          : 'The office will not be supplying this. Locate it from stock if you can.'
      };

    case 'RETURN':
      return {
        kind: NOTICE_KIND.RETURNED,
        severity: NOTICE_SEVERITY.WARNING,
        quantity: amount,
        headline: `${qty(amount, uom)} returned — more detail needed`,
        detail: adminNotes ?? 'The office needs more information before deciding.'
      };

    case 'CONFIRM':
      // Only worth a notice when it is partial: a full confirmation already
      // shows on the line as a confirmed backorder quantity.
      if (fullyDecided) return null;
      return {
        kind: NOTICE_KIND.CONFIRMED,
        severity: NOTICE_SEVERITY.INFO,
        quantity: amount,
        headline: `${qty(amount, uom)} confirmed — on order`,
        detail: adminNotes ?? 'The office is supplying this. No need to keep looking.'
      };

    default:
      return null;
  }
}

/**
 * How much of an action actually answers an instruction.
 *
 * A rejected notice says: the office will not supply this, go and find it. So
 * what settles it is material *newly located*, not the quantity on the request.
 * Bagging 10 where 8 were already on the shelf finds 2 — and passing 10 here
 * closed the whole notice, taking the instruction off the crew's card with the
 * material still unlocated.
 *
 * A returned notice is answered by re-raising the backorder with better
 * information, so there the quantity asked for is the right measure.
 *
 * @param {string} action
 * @param {number} requested     what the crew asked to do
 * @param {number} newlyLocated  what that actually found (see `applyBag`)
 */
export function settlingQuantity(action, requested, newlyLocated) {
  return action === 'BACKORDER_REQUESTED' ? num(requested) : num(newlyLocated);
}

/**
 * Work out how much of a line's outstanding notices a field action settles.
 *
 * Locating material answers a rejected notice directly — the crew was told to
 * find it, and they did. Returned notices are answered by resubmitting a
 * backorder with better information, not by locating.
 *
 * Notices are settled oldest first, so the longest-standing instruction clears
 * before a newer one.
 */
export function planNoticeResolution(notices, action, quantity) {
  const settling = num(quantity);
  const steps = [];
  if (settling <= 0) return { steps, resolved: 0 };

  const answers = {
    CONFIRM_AVAILABLE: [NOTICE_KIND.REJECTED],
    BAG: [NOTICE_KIND.REJECTED],
    DIRECT_ISSUE: [NOTICE_KIND.REJECTED],
    ISSUE_FROM_AVAILABLE: [],
    ISSUE_FROM_BAG: [],
    BACKORDER_REQUESTED: [NOTICE_KIND.RETURNED]
  }[action] ?? [];

  if (!answers.length) return { steps, resolved: 0 };

  const candidates = notices
    .filter((n) => n.status === NOTICE_STATUS.ACTIVE
      && answers.includes(n.kind)
      && num(n.qty_outstanding) > 0)
    .sort((a, b) => new Date(a.raised_at) - new Date(b.raised_at));

  let budget = settling;
  let resolved = 0;

  for (const notice of candidates) {
    if (budget <= 0) break;

    const outstanding = num(notice.qty_outstanding);
    const take = Math.min(budget, outstanding);

    steps.push({
      noticeId: notice.id,
      quantity: take,
      qtyResolved: num(notice.qty_resolved) + take,
      fullyResolved: take >= outstanding
    });

    budget -= take;
    resolved += take;
  }

  return { steps, resolved };
}

/**
 * A notice whose backorder request no longer exists — or which the ledger has
 * moved past — should not keep sitting on the crew's card.
 */
export function isStale(notice, lineState) {
  if (notice.status !== NOTICE_STATUS.ACTIVE) return false;

  // Nothing left to do on the line at all.
  if (num(lineState.remaining) <= 0) return true;

  // A returned notice is moot once the quantity is pending again: the crew
  // resubmitted, so the ball is back with the office.
  if (notice.kind === NOTICE_KIND.RETURNED && num(lineState.pendingBackorder) > 0) {
    return false;
  }

  return false;
}
