/**
 * Value normalisation for imported FMR sheets.
 *
 * These are the rules that survive across projects. Drawings vary in layout —
 * that lives in a profile — but a size written as 1-1/2" means the same thing
 * everywhere, and Excel mangles it the same way everywhere.
 *
 * Ported from FMRv3 BulkImportService.gs, which learned these the hard way.
 */

const MONTHS = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12
};

/**
 * Excel silently converts pipe sizes into dates: 1/2" becomes 2-Jan,
 * 3/4" becomes 4-Mar, 1-1/2 becomes 1.5 or a date. Recover the fraction.
 *
 * The rule: a date whose month and day are both small is far more likely to
 * be a fraction someone typed than an actual date in a materials column.
 */
export function fractionFromDateText(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;

  // "2-Jan", "2 Jan", "Jan-2", "2-January"
  const named = raw.match(/^(\d{1,2})[-\s]([A-Za-z]{3,})$/)
             || raw.match(/^([A-Za-z]{3,})[-\s](\d{1,2})$/);

  if (named) {
    const [a, b] = named.slice(1);
    const monthName = /^[A-Za-z]/.test(a) ? a : b;
    const dayPart = /^[A-Za-z]/.test(a) ? b : a;

    const month = MONTHS[monthName.slice(0, 3).toUpperCase()];
    const day = Number(dayPart);
    if (!month || !Number.isFinite(day)) return null;

    // 2-Jan -> 1/2, 4-Mar -> 3/4, 8-May -> 5/8
    return day > month ? `${month}/${day}` : null;
  }

  // A real Date object that landed in a size column.
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const month = value.getMonth() + 1;
    const day = value.getDate();
    if (day > month && day <= 16) return `${month}/${day}`;
  }

  return null;
}

/**
 * Normalise a pipe size into a consistent written form.
 *
 * Accepts: 6, 6", 6 IN, 1-1/2, 1 1/2", 1.5, and the date-mangled forms above.
 * Produces: 6", 1-1/2", 1/2"
 */
export function normalizeSize(value) {
  if (value == null || value === '') return null;

  const recovered = fractionFromDateText(value);
  const raw = String(recovered ?? value).trim();
  if (!raw) return null;

  // Strip units and quotes, keep digits, dots, slashes, hyphens, spaces.
  const cleaned = raw
    .replace(/["″'']/g, '')
    .replace(/\b(IN|INCH|INCHES|NPS|DN)\b/gi, '')
    .trim();

  if (!cleaned) return null;

  // Whole plus fraction: "1-1/2", "1 1/2"
  const mixed = cleaned.match(/^(\d+)[-\s]+(\d+)\/(\d+)$/);
  if (mixed) {
    const [, whole, numerator, denominator] = mixed;
    return `${Number(whole)}-${Number(numerator)}/${Number(denominator)}"`;
  }

  // Bare fraction: "1/2"
  const fraction = cleaned.match(/^(\d+)\/(\d+)$/);
  if (fraction) return `${Number(fraction[1])}/${Number(fraction[2])}"`;

  // Decimal that is really a fraction: 1.5 -> 1-1/2, 0.75 -> 3/4
  const decimal = cleaned.match(/^(\d+)\.(\d+)$/);
  if (decimal) {
    const asNumber = Number(cleaned);
    const whole = Math.floor(asNumber);
    const remainder = asNumber - whole;

    const known = { 0.125: '1/8', 0.25: '1/4', 0.375: '3/8', 0.5: '1/2',
                    0.625: '5/8', 0.75: '3/4', 0.875: '7/8' };
    const match = Object.entries(known)
      .find(([d]) => Math.abs(remainder - Number(d)) < 0.001);

    if (match) return whole > 0 ? `${whole}-${match[1]}"` : `${match[1]}"`;
    return `${cleaned}"`;
  }

  const whole = cleaned.match(/^(\d+)$/);
  if (whole) return `${Number(whole[1])}"`;

  // Something else — keep it, flagged by the caller if it matters.
  return cleaned;
}

/**
 * Infer a unit of measure from the material description.
 *
 * Pipe and tubing are ordered by length; fittings and valves by the each.
 * Getting this wrong means a crew is told to find 20 feet of elbows.
 */
export function inferUom(description, explicit) {
  const stated = String(explicit ?? '').trim().toUpperCase();
  if (stated) return { uom: stated, rule: 'stated' };

  const text = String(description ?? '').toUpperCase();
  if (!text) return { uom: 'EA', rule: 'default' };

  if (/\b(PIPE|TUBE|TUBING|HOSE|CABLE|WIRE|INSULATION)\b/.test(text)) {
    return { uom: 'FT', rule: 'length material' };
  }
  if (/\b(PAINT|PRIMER|SOLVENT|OIL|GREASE)\b/.test(text)) {
    return { uom: 'GAL', rule: 'liquid' };
  }
  if (/\b(WELD ROD|ELECTRODE|WIRE SPOOL)\b/.test(text)) {
    return { uom: 'LB', rule: 'weight' };
  }
  return { uom: 'EA', rule: 'countable' };
}

/** Quantities arrive as text, sometimes with separators or trailing units. */
export function normalizeQuantity(value) {
  if (value == null || value === '') return null;

  const cleaned = String(value)
    .replace(/,/g, '')
    .replace(/\b(EA|FT|LB|GAL|PCS?|EACH)\b/gi, '')
    .trim();

  const parsed = Number(cleaned);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** Drawing numbers vary in punctuation between projects. */
export function normalizeIso(value) {
  const raw = String(value ?? '').trim().toUpperCase();
  if (!raw) return null;
  return raw.replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/** Sheet numbers: "1", "01", "SHT 1", "Sheet 01" all mean sheet 01. */
export function normalizeSheet(value) {
  const raw = String(value ?? '').trim().toUpperCase();
  if (!raw) return null;

  const match = raw.match(/(\d+)\s*$/);
  if (!match) return raw;

  return String(Number(match[1])).padStart(2, '0');
}
