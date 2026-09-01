/**
 * Bag tag numbers.
 *
 * A crew writes this on the bag in marker pen, so the shape matters: a prefix
 * that says which system issued it, the year, and a zero-padded counter that
 * stays the same width all year. Ported from FMRv3 FieldService.gs:731.
 *
 * The format lives here, apart from the counter that feeds it, so it can be
 * read and tested without a database — the counter itself needs a row lock and
 * belongs in services/controls.js.
 */

/** How a tag number reads once it is on the bag: BT-2026-00042. */
export function formatBagTagNumber(prefix, year, sequence) {
  return `${prefix}-${year}-${String(sequence).padStart(5, '0')}`;
}

/** Matches a tag this system issued, so its counter can be read back out. */
export const BAG_TAG_PATTERN = /^([A-Z][A-Z0-9-]*)-(\d{4})-(\d+)$/;

/**
 * Read a tag number back into its parts, or null if this system did not issue
 * it. A crew bagging into a pre-printed tag types whatever is on it, and those
 * must not be mistaken for a counter value.
 */
export function parseBagTagNumber(tagNumber) {
  const match = BAG_TAG_PATTERN.exec(String(tagNumber ?? '').trim().toUpperCase());
  if (!match) return null;

  return { prefix: match[1], year: Number(match[2]), sequence: Number(match[3]) };
}
