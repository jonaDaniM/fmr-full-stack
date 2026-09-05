/**
 * Working out how well a profile fits a real workbook.
 *
 * The parser matches column headings exactly, give or take punctuation and
 * case. That is deliberate — a fuzzy match that guesses "QTY ORDERED" is the
 * requested quantity will eventually guess wrong, and a wrong quantity sends a
 * crew looking for material that was never asked for.
 *
 * The cost of exactness is that an unrecognised heading fails silently: the
 * column is simply not found. This module is what turns that into something a
 * person can see and fix — it reports which headings in the file were matched,
 * which were not, and what each unmatched one most plausibly is.
 *
 * Pure. No database, no file system.
 */

const clean = (value) => String(value ?? '').trim();
const upper = (value) => clean(value).toUpperCase();
const squash = (value) => upper(value).replace(/[^A-Z0-9]/g, '');

/** The fields an import needs before it can produce anything usable. */
export const ESSENTIAL = Object.freeze(['description', 'quantity']);

/**
 * Words that suggest what an unfamiliar heading is for.
 *
 * Only ever used to *suggest* a mapping to a person, never to apply one. The
 * person confirms; the profile then records the exact heading, so the next
 * import matches exactly rather than by guesswork.
 */
const HINTS = Object.freeze({
  quantity: ['QTY', 'QUANT', 'AMOUNT', 'EACH', 'COUNT', 'REQD', 'REQUIRED'],
  description: ['DESC', 'MATERIAL', 'ITEM DESC', 'NOMENCLATURE', 'DETAIL'],
  commodityCode: ['COMMODITY', 'CMDTY', 'CODE', 'PART', 'STOCK', 'CATALOG', 'IDENT'],
  size: ['SIZE', 'NPS', 'DN', 'DIA', 'BORE', 'NPD'],
  uom: ['UOM', 'UNIT', 'U/M', 'MEASURE'],
  lineNumber: ['ITEM', 'LINE', 'NO', 'SEQ', 'MARK'],
  storageLocation: ['LOCATION', 'BIN', 'RACK', 'SHELF', 'STORE', 'WHSE']
});

/**
 * Every heading the profile currently knows, as a lookup back to its field.
 *
 * An alias made only of punctuation — the baseline has "#" for the item number
 * — squashes to an empty string, which would then match every blank cell in
 * the sheet. That made a two-cell header block outscore the real heading row.
 * Such aliases are still matched, but on their exact text rather than squashed.
 */
function knownHeadings(columns = {}) {
  const map = new Map();
  for (const [field, aliases] of Object.entries(columns)) {
    for (const alias of aliases ?? []) {
      const key = squash(alias);
      map.set(key || upper(alias), field);
    }
  }
  return map;
}

/** Look a heading up, never matching a blank cell against anything. */
function fieldFor(known, heading) {
  const text = clean(heading);
  if (!text) return undefined;
  return known.get(squash(text)) ?? known.get(upper(text));
}

/**
 * The row in a sheet that looks most like the table's heading row.
 *
 * Same rule the parser uses — the row matching the most known headings — but
 * it also returns rows that match nothing, because a sheet the profile cannot
 * read at all is exactly the case this screen exists for.
 */
export function likelyHeaderRow(grid, columns = {}, { searchRows = 40 } = {}) {
  const known = knownHeadings(columns);
  let best = null;

  for (let r = 0; r < Math.min(searchRows, grid.length); r += 1) {
    const row = grid[r] ?? [];
    const filled = row.filter((cell) => clean(cell)).length;
    if (filled < 2) continue;

    const matched = row.filter((cell) => fieldFor(known, cell)).length;

    // Prefer the row matching the most known headings; failing that, the
    // widest row of text, which is what a heading row looks like when none of
    // its wording is recognised yet.
    const score = matched * 100 + filled;
    if (!best || score > best.score) {
      best = { row: r, matched, filled, score, cells: row.map(clean) };
    }
  }

  return best;
}

/** What a heading is probably for, or null when nothing suggests itself. */
export function suggestField(heading) {
  const text = upper(heading);
  if (!text) return null;

  for (const [field, hints] of Object.entries(HINTS)) {
    if (hints.some((hint) => text.includes(hint))) return field;
  }
  return null;
}

/**
 * How a profile fares against one sheet.
 *
 * Returns what matched, what did not, and what is missing — the three things
 * somebody needs in order to fix a profile without reading any code.
 */
export function fitReport(grid, profile, { searchRows } = {}) {
  const columns = profile?.columns ?? {};
  const known = knownHeadings(columns);
  const header = likelyHeaderRow(grid, columns, {
    searchRows: searchRows ?? profile?.headerSearchRows ?? 40
  });

  if (!header) {
    return {
      headerRow: null, matched: [], unmatched: [],
      missing: [...ESSENTIAL], usable: false
    };
  }

  const matched = [];
  const unmatched = [];
  const seen = new Set();

  header.cells.forEach((heading, index) => {
    if (!heading) return;
    const field = fieldFor(known, heading);

    if (field) {
      // A heading already claimed by another column is a duplicate, not a
      // second mapping — the parser takes the first.
      if (seen.has(field)) return;
      seen.add(field);
      matched.push({ heading, field, index });
    } else {
      unmatched.push({ heading, index, suggestion: suggestField(heading) });
    }
  });

  const missing = ESSENTIAL.filter((field) => !seen.has(field));

  return {
    headerRow: header.row,
    matched,
    unmatched,
    missing,
    usable: missing.length === 0
  };
}

/**
 * Add a heading to a profile's list for a field.
 *
 * The exact text is recorded, so the next import matches it outright rather
 * than re-deriving a guess. Returns a new profile; the original is untouched.
 */
export function learnHeading(profile, field, heading) {
  const text = clean(heading);
  if (!text) throw new Error('A heading cannot be blank.');
  if (!field) throw new Error('Choose what this column holds.');

  const columns = { ...(profile.columns ?? {}) };
  const existing = columns[field] ?? [];

  // Already known, in any punctuation: nothing to add.
  if (existing.some((alias) => squash(alias) === squash(text))) return profile;

  return { ...profile, columns: { ...columns, [field]: [...existing, text] } };
}

/** Remove a heading a person mapped by mistake. */
export function forgetHeading(profile, field, heading) {
  const columns = { ...(profile.columns ?? {}) };
  const existing = columns[field] ?? [];
  const kept = existing.filter((alias) => squash(alias) !== squash(heading));
  return { ...profile, columns: { ...columns, [field]: kept } };
}

/**
 * Refuse a profile that cannot produce a usable import.
 *
 * Saving a broken profile is worse than not saving one: the next person to
 * import gets an empty batch and no reason for it.
 */
export function validateProfile(profile) {
  const problems = [];

  if (!profile || typeof profile !== 'object') {
    return ['A profile must be an object.'];
  }

  const columns = profile.columns ?? {};
  for (const field of ESSENTIAL) {
    if (!(columns[field] ?? []).length) {
      problems.push(`No column heading is mapped to ${field}. `
        + 'An import cannot produce a line without it.');
    }
  }

  for (const [field, aliases] of Object.entries(columns)) {
    if (!Array.isArray(aliases)) {
      problems.push(`Headings for ${field} must be a list.`);
      continue;
    }
    for (const alias of aliases) {
      if (!clean(alias)) problems.push(`A blank heading is mapped to ${field}.`);
    }
  }

  for (const pattern of profile.stopPatterns ?? []) {
    try {
      new RegExp(pattern);
    } catch {
      problems.push(`"${pattern}" is not a valid pattern.`);
    }
  }

  return problems;
}
