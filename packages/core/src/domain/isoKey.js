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

  const match = body.match(/^(.*)-(\d{2})$/);
  if (!match) return [body];

  const [, drawing, sheet] = match;
  const candidates = [body, `${drawing}|${sheet}`];

  // "05" and "5" are the same sheet to a human.
  const numeric = String(Number(sheet));
  if (numeric !== sheet) candidates.push(`${drawing}|${numeric}`);

  return candidates;
}
