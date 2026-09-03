/**
 * Where the work a failing check found is actually done.
 *
 * A health or integrity check that fires reports a count, and the integrity
 * ones name a few FMRs — and then left the owner to work out for themselves
 * which screen holds those rows. "2 backorders awaiting a decision" is a
 * useful thing to know and a frustrating thing to be told, if nothing on the
 * page goes there.
 *
 * Keyed on the check's `code`, never its wording: the names are sentences
 * written for a person and are expected to be rephrased, and a route that
 * broke silently when one was would be worse than no route.
 *
 * Checks with no entry here simply show no link. That is the right default —
 * several integrity checks describe a disagreement between tables that no one
 * screen owns, and inventing a destination for those would send someone to a
 * page that cannot help them.
 *
 * This lives in its own file, with no DOM in it, so `check-routes.test.js` can
 * import it and hold it against the codes the services actually emit.
 */

export const CHECK_DESTINATIONS = Object.freeze({
  // Health, from services/controls.js
  STALE_BACKORDERS: { href: '/admin.html', label: 'Decide them in the Office queue' },
  UNRESOLVED_NOTICES: { tab: 'notices', label: 'See them on the Notices tab' },
  STALE_BAGS: { href: '/admin.html', label: 'Find them under Active bags' },

  // Integrity, from services/integrity.js
  ACTIVE_NOTICE_WITHOUT_REQUEST: { tab: 'notices', label: 'See them on the Notices tab' },
  ORPHANED_BAG_ITEM: { href: '/admin.html', label: 'Find them under Active bags' },
  BACKORDER_EXCEEDS_OUTSTANDING: { href: '/admin.html', label: 'Review them in the Office queue' }
});

/** The route for a check, or null when it has none or found nothing. */
export function destinationFor(check) {
  if (!check || check.ok) return null;
  return CHECK_DESTINATIONS[check.code] ?? null;
}
