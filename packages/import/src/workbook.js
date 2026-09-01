/**
 * Reading a workbook into grids.
 *
 * The extraction engine works on plain arrays of rows, so the file format is
 * kept behind this one interface. CSV is handled here directly. XLSX needs a
 * parser, and the choice of parser is deliberately left to the deployment:
 *
 *   The `xlsx` package on the npm registry is no longer maintained there and
 *   carries unfixed prototype-pollution and ReDoS advisories. SheetJS now
 *   publishes from their own CDN (cdn.sheetjs.com), which is the supported
 *   route. Install it there and pass it in via setXlsxParser(), or use a
 *   maintained alternative such as exceljs.
 *
 * Keeping the dependency injected means the engine and its tests never depend
 * on which parser a deployment picked.
 */

import { parseCsv } from '../../migrate/src/index.js';

let xlsxParser = null;

/**
 * Supply the XLSX parser.
 *
 * @param {object} parser  an object with read(buffer, opts) and
 *                         utils.sheet_to_json(sheet, opts), i.e. the SheetJS
 *                         interface. exceljs can be adapted in a few lines.
 */
export function setXlsxParser(parser) {
  xlsxParser = parser;
}

export class WorkbookError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorkbookError';
  }
}

/** A CSV is a workbook of one sheet. */
export function readCsv(text, name = 'Sheet1') {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === ',') { row.push(field); field = ''; continue; }
    if (char === '\r') continue;
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += char;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  return [{ name, grid: rows }];
}

/**
 * Read an XLSX workbook into grids.
 *
 * Cells are read raw so a size Excel turned into a date arrives as a Date
 * object rather than a locale-formatted string — normalizeSize() knows how to
 * recover both, but the Date carries more information.
 */
export function readXlsx(buffer) {
  if (!xlsxParser) {
    throw new WorkbookError(
      'No XLSX parser configured. Install one (see packages/import/src/workbook.js) ' +
      'and call setXlsxParser(), or supply the file as CSV.'
    );
  }

  const workbook = xlsxParser.read(buffer, { type: 'buffer', cellDates: true });

  return workbook.SheetNames.map((name) => ({
    name,
    grid: xlsxParser.utils.sheet_to_json(workbook.Sheets[name], {
      header: 1,
      raw: true,
      defval: '',
      blankrows: true
    })
  }));
}

/** Read whichever format this is. */
export function readWorkbook(buffer, filename) {
  const name = String(filename ?? '');

  if (/\.csv$/i.test(name)) {
    return readCsv(buffer.toString('utf8'), name.replace(/\.csv$/i, ''));
  }
  if (/\.xlsx?$/i.test(name)) {
    return readXlsx(buffer);
  }
  throw new WorkbookError(`Cannot read "${name}". Supply a .xlsx or .csv file.`);
}
