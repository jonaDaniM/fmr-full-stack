/**
 * The Material Takeoff — what the material team buys from.
 *
 * An FMR asks the warehouse to fetch material somebody has already bought.
 * An MTO comes earlier and asks a different question: this is what the work
 * package needs, go and quote it. It is the first document of the project,
 * before any FMR exists.
 *
 *   drawings arrive → MTO → quoted and ordered → material arrives
 *                                                      ↓
 *                             FMRs published → crews fetch it
 *
 * The same drawing scan feeds both, so an MTO costs no extra reading. What it
 * adds is the pipe schedule (the buyer cannot order wall thickness without
 * it) and a split by how material is bought: bolts and gaskets come from
 * different suppliers on different lead times than pipe and fittings, which
 * is why the takeoff form has a sheet for each.
 *
 * Written as CSV rather than xlsx deliberately. The workbook template belongs
 * to the client and varies by project; a CSV opens in Excel, pastes into
 * whatever template is current, and needs no dependency — the xlsx package is
 * unmaintained and this system stays free of it.
 */

import { LedgerError } from '../../core/src/domain/ledger.js';

/**
 * The takeoff form's own columns, in its own order.
 *
 * Taken from the client's real filled-in workbook
 * (`Archive/templates/createMTO/`), not inferred. The three paint columns are
 * blank in every example seen so far, but they are on the form the purchasing
 * team reads, and a missing column shifts everything after it on paste.
 */
const COLUMNS = Object.freeze([
  ['cwa', 'CWA'],
  ['iwp', 'IWP'],
  ['lineNumber', 'LINE NUMBER'],
  ['sheet', 'SHEET'],
  ['pipeSpec', 'PIPE SPEC'],
  ['description', 'DESCRIPTION'],
  ['size', 'SIZE'],
  ['commodityCode', 'COMMODITY CODE'],
  ['quantity', 'QTY'],
  ['uom', 'UOM'],
  ['epicPaintCode', 'EPIC PAINT CODE'],
  ['custPaintCode', 'CUST. PAINT CODE'],
  ['color', 'COLOR']
]);

/**
 * The sheets of the form, in the order the client's workbook has them.
 *
 * COMBINED holds every row; the category sheets are the same material sorted
 * by how it is bought. Blinds, valves and birdscreens are quoted separately
 * from pipe, which is why they get sheets of their own rather than being
 * lumped in with fittings.
 */
export const TAKEOFF_SHEETS = Object.freeze([
  'COMBINED',
  'BLINDS',
  'PIPE & FITTINGS',
  'BOLTS & GASKETS',
  'SUPPORTS',
  'VALVES',
  'BIRDSCREENS',
  'OTHER MATERIALS'
]);

const BLIND_RE = /\bBLINDS?\b/i;
const BIRDSCREEN_RE = /\bBIRD\s*SCREENS?\b/i;
const VALVE_RE =
  /(?:\bVALVES?\b|^\s*(?:BALL|CHECK|GATE|GLOBE|BUTTERFLY|DIAPHRAGM|PLUG|NEEDLE|CONTROL|RELIEF|SAFETY)\b)/i;
const PIPE_FITTING_RE =
  /\b(?:PIPE|ELL|ELBOW|TEE|REDUCER|CAP|COUPLING|SOCKOLET|WELDOLET|THREDOLET|NIPPLE|FLANGE|UNION|SWAGE)\b/i;

/**
 * Which sheet a row belongs on.
 *
 * Ported from the client's own `material_category_sheet`, including the order
 * of the tests — a blind is a blind before it is anything else, and a ball
 * valve is a valve rather than a fitting. Changing the order silently moves
 * material onto the wrong buyer's sheet.
 */
export function takeoffSheetFor(itemType, description) {
  const type = String(itemType ?? '').trim().toUpperCase();
  const text = String(description ?? '').replace(/\s+/g, ' ').trim();

  if (BLIND_RE.test(text)) return 'BLINDS';
  if (['BOLT', 'GASKET', 'WASHER'].includes(type)) return 'BOLTS & GASKETS';
  if (type === 'SUPPORT') return 'SUPPORTS';
  if (BIRDSCREEN_RE.test(text)) return 'BIRDSCREENS';
  if (VALVE_RE.test(text)) return 'VALVES';
  if (['PIPE', 'FITTING'].includes(type) || PIPE_FITTING_RE.test(text)) {
    return 'PIPE & FITTINGS';
  }
  return 'OTHER MATERIALS';
}

/**
 * One CSV cell.
 *
 * A commodity code like `5UGSP-02-15` is text, but a bare `1-2` is read by
 * Excel as a date — the same class of damage that turns 3/4" into 4-Mar on the
 * way in. Quoting every non-empty cell costs nothing and stops it.
 */
function cell(value) {
  const text = value == null ? '' : String(value);
  if (text === '') return '';
  return `"${text.replace(/"/g, '""')}"`;
}

/** One sheet of the takeoff, as CSV. */
export function takeoffCsv(rows) {
  const lines = [COLUMNS.map(([, label]) => cell(label)).join(',')];
  for (const row of rows) {
    lines.push(COLUMNS.map(([key]) => cell(row[key])).join(','));
  }
  // CRLF: Excel is the destination, and it is what the format specifies.
  return lines.join('\r\n');
}

/**
 * Group takeoff rows the way the form does.
 *
 * Every sheet is present even when empty — a buyer opening the file needs to
 * see that there are no bolts on this package, not wonder whether the sheet
 * failed to generate.
 */
export function groupBySheet(rows) {
  const grouped = new Map(TAKEOFF_SHEETS.map((name) => [name, []]));

  for (const row of rows ?? []) {
    // COMBINED is the whole takeoff; the category sheets are the same rows
    // sorted by who quotes them. A row appears on both, as it does on the
    // client's own workbook.
    grouped.get('COMBINED').push(row);

    const sheet = takeoffSheetFor(row.itemType, row.description);
    grouped.get(grouped.has(sheet) ? sheet : 'OTHER MATERIALS').push(row);
  }

  return grouped;
}

/**
 * The whole takeoff as one CSV, sheets in sequence.
 *
 * One file rather than three: the buyer forwards a single attachment, and the
 * sheet headings survive a paste into the client's own template.
 */
export function takeoffDocument({ rows, iwpNumber, cwa, drawings, missingPipeSpec }) {
  if (!rows?.length) {
    throw new LedgerError(
      'Those drawings hold no material to take off.', 'NO_MATERIAL'
    );
  }

  const grouped = groupBySheet(rows);
  const parts = [];

  parts.push([
    cell('MATERIAL TAKEOFF'),
    cell(iwpNumber || ''),
    cell(cwa ? `CWA ${cwa}` : ''),
    cell(`${drawings} drawing${drawings === 1 ? '' : 's'}`),
    cell(`${rows.length} line${rows.length === 1 ? '' : 's'}`)
  ].join(','));

  // Pipe nobody can order is worth saying at the top, not discovering at the
  // quoting stage.
  if (missingPipeSpec) {
    parts.push(cell(
      `${missingPipeSpec} pipe line${missingPipeSpec === 1 ? '' : 's'} `
      + 'had no pipe schedule on the drawing — check before ordering.'
    ));
  }

  for (const name of TAKEOFF_SHEETS) {
    const sheetRows = grouped.get(name);
    parts.push('', cell(name), takeoffCsv(sheetRows));
    if (!sheetRows.length) parts.push(cell('(nothing on this package)'));
  }

  return parts.join('\r\n');
}

/** What to call the file, so a folder of them stays readable. */
export function takeoffFilename({ iwpNumber, cwa }) {
  const stem = [cwa, iwpNumber].filter(Boolean).join('-') || 'package';
  return `MTO ${stem.replace(/[^A-Za-z0-9._-]+/g, '_')}.csv`;
}
