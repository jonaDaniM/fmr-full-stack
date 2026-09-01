/**
 * Extraction engine.
 *
 * Drawings keep a similar shape across projects but never quite the same one:
 * a label moves, a column is renamed, a header sits two rows lower. So the
 * engine is fixed and the variation lives in a profile — a small JSON file
 * per project describing where things are and what they are called.
 *
 * Adding a project means writing a profile, not editing this file.
 */

import {
  normalizeSize, normalizeQuantity, inferUom, normalizeIso, normalizeSheet
} from './normalize.js';

export const SEVERITY = { ERROR: 'error', WARNING: 'warning' };

const clean = (v) => String(v ?? '').trim();
const upper = (v) => clean(v).toUpperCase();

/**
 * Find a labelled value in the header block.
 *
 * Sheets put "FMR No:" in one cell and its value in the next, or in the cell
 * below, or two cells over when someone merged a column. Look right first,
 * then down.
 */


/**
 * Is this cell another field's label rather than a value?
 *
 * Header blocks pack several labelled fields onto one row, so the cell to the
 * right of "FMR NO." is often "SHT:" rather than the FMR number. A blank
 * field is better than a wrong one.
 */
function looksLikeLabel(value) {
  const text = String(value).trim();
  if (/[:=]\s*$/.test(text)) return true;
  return text.split(/\r?\n/).some((line) => /[:=]\s*$/.test(line.trim()));
}

/**
 * Pull a value out of a cell that carries its own label.
 *
 * Handles "IWP: ABC-123" on one line and a label with its value on the next
 * line of the same cell, which is how merged template cells arrive.
 */
function matchInline(rawCell, wanted) {
  if (!rawCell) return null;

  for (const piece of String(rawCell).split(/\r?\n/)) {
    const text = piece.trim();
    if (!text) continue;

    const separator = text.match(/^(.+?)\s*[:=]\s*(.+)$/);
    if (!separator) continue;

    const label = upper(separator[1]).replace(/[:.\s]+$/, '');
    const value = separator[2].trim();
    if (value && wanted.includes(label)) return value;
  }

  // "IWP: ABC" on one line, its value alone on the next.
  const lines = String(rawCell).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length - 1; i++) {
    const label = upper(lines[i]).replace(/[:.\s]+$/, '');
    if (wanted.includes(label) && lines[i + 1]) return lines[i + 1];
  }

  return null;
}

export function findLabeledValue(grid, aliases, { searchRows = 25 } = {}) {
  const wanted = aliases.map((a) => upper(a).replace(/[:.\s]+$/, ''));

  for (let r = 0; r < Math.min(searchRows, grid.length); r++) {
    const row = grid[r] ?? [];

    for (let c = 0; c < row.length; c++) {
      const raw = clean(row[c]);
      const cell = upper(raw).replace(/[:.\s]+$/, '');

      // Some templates merge the label and its value into one cell —
      // "IWP: IP-SMM30C0012FPP-K447-104" — or stack them on separate lines
      // within it. Take what follows the label.
      const inline = matchInline(raw, wanted);
      if (inline) return { value: inline, row: r, col: c };

      if (!wanted.includes(cell)) continue;

      // to the right
      for (let offset = 1; offset <= 3; offset++) {
        const value = clean(row[c + offset]);
        if (value && !looksLikeLabel(value)) return { value, row: r, col: c + offset };
      }
      // below
      for (let offset = 1; offset <= 2; offset++) {
        const value = clean(grid[r + offset]?.[c]);
        if (value && !looksLikeLabel(value)) return { value, row: r + offset, col: c };
      }
    }
  }

  return null;
}

/**
 * Find the row where the material table starts, by looking for a row that
 * contains several of the expected column headings at once.
 */
export function findTableHeader(grid, columns, { searchRows = 40 } = {}) {
  const allAliases = Object.entries(columns).map(([key, aliases]) => ({
    key,
    aliases: aliases.map(upper)
  }));

  let best = null;

  for (let r = 0; r < Math.min(searchRows, grid.length); r++) {
    const row = (grid[r] ?? []).map(upper);
    const found = {};

    for (const { key, aliases } of allAliases) {
      const index = row.findIndex((cell) => cell && aliases.some((a) =>
        cell === a || cell.replace(/[^A-Z0-9]/g, '') === a.replace(/[^A-Z0-9]/g, '')
      ));
      if (index >= 0) found[key] = index;
    }

    const score = Object.keys(found).length;
    if (score >= 2 && (!best || score > best.score)) {
      best = { row: r, columns: found, score };
    }
  }

  return best;
}

/**
 * Read one worksheet into a proposed FMR.
 *
 * @param {string[][]} grid    the sheet as rows of cells
 * @param {object} profile     the project's extraction profile
 * @param {string} sheetName
 */
export function extractSheet(grid, profile, sheetName = '') {
  const issues = [];
  const note = (severity, code, message, extra = {}) =>
    issues.push({ severity, code, message, sheet: sheetName, ...extra });

  // --- material table, found first so the header search knows where to stop
  const table = findTableHeader(grid, profile.columns ?? {}, {
    searchRows: profile.headerSearchRows ?? 40
  });

  // Header fields sit above the table. Searching past it starts matching the
  // table's own column headings instead.
  const headerRows = table
    ? table.row
    : Math.min(profile.headerSearchRows ?? 25, grid.length);

  const header = {};
  for (const [field, spec] of Object.entries(profile.header ?? {})) {
    const found = findLabeledValue(grid, spec.aliases, { searchRows: headerRows });

    if (!found) {
      if (spec.required) {
        note(SEVERITY.ERROR, 'MISSING_HEADER', `Could not find "${field}" on the sheet.`, { field });
      }
      continue;
    }
    header[field] = found.value;
  }

  header.isoNumber = normalizeIso(header.isoNumber);
  header.isoSheet = normalizeSheet(header.isoSheet) ?? profile.defaultSheet ?? '01';

  if (!table) {
    note(SEVERITY.ERROR, 'NO_TABLE', 'Could not find the material table on this sheet.');
    return { header, lines: [], issues };
  }

  for (const required of profile.requiredColumns ?? ['quantity', 'description']) {
    if (!(required in table.columns)) {
      note(SEVERITY.ERROR, 'MISSING_COLUMN',
        `The material table has no "${required}" column.`, { field: required });
    }
  }

  // --- rows
  const lines = [];
  const stopAfterBlank = profile.stopAfterBlankRows ?? 3;
  let blankRun = 0;

  for (let r = table.row + 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const at = (key) => {
      const index = table.columns[key];
      return index == null ? '' : clean(row[index]);
    };

    const description = at('description');
    const rawQuantity = at('quantity');

    if (!description && !rawQuantity) {
      if (++blankRun >= stopAfterBlank) break;
      continue;
    }
    blankRun = 0;

    // A totals row is not a material line.
    if (profile.stopPatterns?.some((p) => new RegExp(p, 'i').test(description))) break;

    const quantity = normalizeQuantity(rawQuantity);
    const size = normalizeSize(at('size'));
    const { uom, rule } = inferUom(description, at('uom'), rawQuantity);

    const line = {
      sourceRow: r + 1,
      lineNumber: lines.length + 1,
      commodityCode: at('commodityCode') || null,
      size,
      description: description || null,
      quantity,
      uom,
      uomRule: rule,
      storageLocation: at('storageLocation') || null
    };

    if (quantity == null) {
      note(SEVERITY.ERROR, 'BAD_QUANTITY',
        `Row ${r + 1}: quantity "${rawQuantity}" is not a number.`,
        { row: r + 1, value: rawQuantity });
    } else if (quantity === 0) {
      note(SEVERITY.WARNING, 'ZERO_QUANTITY', `Row ${r + 1}: quantity is zero.`, { row: r + 1 });
    }

    if (!description) {
      note(SEVERITY.WARNING, 'NO_DESCRIPTION',
        `Row ${r + 1}: no material description.`, { row: r + 1 });
    }

    // A size that survived normalisation unrecognised is worth a look: this
    // is usually where Excel's date conversion has done something new.
    if (at('size') && size && !/^[\d\-/]+"?(x[\d\-/]+"?)?$/.test(size)) {
      note(SEVERITY.WARNING, 'ODD_SIZE',
        `Row ${r + 1}: could not read the size "${at('size')}".`,
        { row: r + 1, value: at('size') });
    }

    lines.push(line);
  }

  if (!lines.length) {
    note(SEVERITY.ERROR, 'NO_LINES', 'No material lines were found on this sheet.');
  }

  return { header, lines, issues };
}

/** Extract every worksheet in a workbook. */
export function extractWorkbook(sheets, profile) {
  const results = [];

  for (const { name, grid } of sheets) {
    if (profile.skipSheets?.some((p) => new RegExp(p, 'i').test(name))) continue;

    const result = extractSheet(grid, profile, name);
    results.push({ sheetName: name, ...result });
  }

  return {
    sheets: results,
    summary: {
      sheets: results.length,
      lines: results.reduce((t, r) => t + r.lines.length, 0),
      errors: results.reduce((t, r) =>
        t + r.issues.filter((i) => i.severity === SEVERITY.ERROR).length, 0),
      warnings: results.reduce((t, r) =>
        t + r.issues.filter((i) => i.severity === SEVERITY.WARNING).length, 0)
    }
  };
}
