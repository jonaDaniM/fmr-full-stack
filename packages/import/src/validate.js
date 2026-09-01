/**
 * Draft validation.
 *
 * The same rules run twice, at different strictness. Saving a draft is lenient
 * — someone typing up a requisition should be able to stop halfway and come
 * back to it, with the gaps recorded rather than refused. Publishing is strict,
 * because once it is published the crews are working from it.
 *
 * The only difference between the two passes is whether an FMR number is
 * required, which is how FMRv3 drew the same line.
 *
 * Values go through the same normalisation as imported ones, so a hand-typed
 * `1-1/2` and an imported `1-1/2` end up identical.
 */

import {
  normalizeSize, normalizeQuantity, inferUom, normalizeIso, normalizeSheet
} from './normalize.js';

export const SEVERITY = { ERROR: 'error', WARNING: 'warning' };

const clean = (v) => String(v ?? '').trim();

/**
 * Check one draft.
 *
 * @param {object} draft            { header, lines }
 * @param {object} options
 * @param {boolean} options.requireFmrNumber  strict pass, i.e. publishing
 * @returns {{ valid: boolean, issues: Array, normalized: object }}
 */
export function validateDraft(draft, { requireFmrNumber = false } = {}) {
  const issues = [];
  const header = draft?.header ?? {};
  const lines = Array.isArray(draft?.lines) ? draft.lines : [];

  const note = (severity, code, message, extra = {}) =>
    issues.push({ severity, code, message, ...extra });

  // --- header
  const fmrNumber = clean(header.fmrNumber).toUpperCase();
  const isoNumber = normalizeIso(header.isoNumber);
  const isoSheet = normalizeSheet(header.isoSheet);

  if (!fmrNumber && requireFmrNumber) {
    note(SEVERITY.ERROR, 'NO_FMR_NUMBER',
      'An FMR number is required before this can be published.', { field: 'fmrNumber' });
  }

  if (!clean(header.iwpNumber)) {
    note(SEVERITY.WARNING, 'NO_IWP', 'No IWP number.', { field: 'iwpNumber' });
  }

  if (!isoNumber) {
    note(SEVERITY.ERROR, 'NO_ISO', 'A drawing number is required.', { field: 'isoNumber' });
  }
  if (!isoSheet) {
    note(SEVERITY.ERROR, 'NO_SHEET', 'A drawing sheet is required.', { field: 'isoSheet' });
  }

  if (!lines.length) {
    note(SEVERITY.ERROR, 'NO_LINES', 'An FMR needs at least one material line.');
  }

  // --- lines
  const normalizedLines = lines.map((line, index) => {
    const lineNumber = index + 1;
    const at = (code, message, severity = SEVERITY.ERROR) =>
      note(severity, code, `Line ${lineNumber}: ${message}`, { lineNumber });

    const description = clean(line.description);
    const quantity = normalizeQuantity(line.quantity);
    const size = normalizeSize(line.size);
    const { uom, rule } = inferUom(description, line.uom, line.quantity);

    if (!description) {
      at('NO_DESCRIPTION', 'no material description.');
    }

    if (quantity == null) {
      at('BAD_QUANTITY', `quantity "${clean(line.quantity)}" is not a number.`);
    } else if (quantity <= 0) {
      at('ZERO_QUANTITY', 'quantity must be greater than zero.');
    }

    // A size that survives normalisation unrecognised usually means something
    // was pasted in from a spreadsheet that mangled it.
    if (clean(line.size) && size && !/^[\d\-/]+"?(x[\d\-/]+"?)?$/.test(size)) {
      at('ODD_SIZE', `could not read the size "${clean(line.size)}".`, SEVERITY.WARNING);
    }

    return {
      lineNumber,
      commodityCode: clean(line.commodityCode) || null,
      size,
      description: description || null,
      quantity,
      uom,
      uomRule: rule,
      storageLocation: clean(line.storageLocation) || null
    };
  });

  return {
    valid: !issues.some((i) => i.severity === SEVERITY.ERROR),
    issues,
    normalized: {
      header: {
        fmrNumber: fmrNumber || null,
        iwpNumber: clean(header.iwpNumber) || null,
        isoNumber,
        isoSheet,
        requestedBy: clean(header.requestedBy) || null,
        dateRequired: parseDate(header.dateRequired),
        priority: clean(header.priority) || null,
        notes: clean(header.notes) || null
      },
      lines: normalizedLines
    }
  };
}

/**
 * Parse pasted rows into lines.
 *
 * The team enters material by pasting a block out of a spreadsheet, so accept
 * tab- or comma-separated, and skip a header row if one came along with it.
 * Column order follows FMRv3's intake form.
 */
export function parsePastedLines(text) {
  const rows = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!rows.length) return [];

  const split = (row) => (row.includes('\t') ? row.split('\t') : row.split(','))
    .map((cell) => cell.trim());

  const first = split(rows[0]);
  const looksLikeHeader = /commodity|code|desc|qty|quant/i.test(first.join(' '))
    && !/^\d/.test(first[first.length - 1] ?? '');

  return rows.slice(looksLikeHeader ? 1 : 0).map((row) => {
    const [commodityCode, size, description, quantity, uom, storageLocation] = split(row);
    return { commodityCode, size, description, quantity, uom, storageLocation };
  });
}

function parseDate(value) {
  const raw = clean(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}
