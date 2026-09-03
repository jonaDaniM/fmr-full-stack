/**
 * ISO drawing keys.
 *
 * A line is identified by drawing number and sheet: "D-1234" sheet "05"
 * becomes the key "D-1234|05". Crews type these into a phone in a warehouse,
 * so entry is forgiving.
 */

export const clean = (value) => String(value ?? '').trim().toUpperCase();

export function isoKey(isoNumber, isoSheet) {
  const iso = clean(isoNumber);
  const sheet = clean(isoSheet);
  if (!iso || !sheet) throw new Error('ISO number and sheet are both required.');
  return `${iso}|${sheet}`;
}

/**
 * Work out what the crew meant by a search term.
 *
 * A bare "D-1234-05" is ambiguous: it could be a drawing whose number ends
 * in -05, or drawing D-1234 sheet 05. Return both, and let the query match
 * whichever exists.
 */
export function isoCandidates(query) {
  const raw = clean(query);
  if (!raw) return [];

  const body = raw.startsWith('ISO:') ? raw.slice(4) : raw;

  // Already explicit — leave it alone.
  if (body.includes('|') || body.includes('/') || /\b(SHT|SHEET)\b/.test(body)) {
    return [body];
  }

  // One or two digits. Sheets are written both ways and the shorter is by far
  // the commoner: of the real drawings, 628 use a single-digit sheet and 56 use
  // two. Matching only two digits meant a crew typing "LP131-SC-824001-5" — the
  // way it is written on the sheet — got nothing back for 91% of the lines on
  // the project, while the same drawing without the suffix found all 24.
  const match = body.match(/^(.*)-(\d{1,2})$/);
  if (!match) return [body];

  const [, drawing, sheet] = match;

  // Both readings are tried, so guessing at a sheet costs nothing: a drawing
  // whose number genuinely ends in "-5" still matches as itself.
  const candidates = [body, `${drawing}|${sheet}`];

  // "05" and "5" are the same sheet to a human.
  const numeric = String(Number(sheet));
  if (numeric !== sheet) candidates.push(`${drawing}|${numeric}`);

  return candidates;
}
