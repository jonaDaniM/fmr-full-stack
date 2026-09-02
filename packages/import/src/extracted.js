/**
 * Bringing extracted drawing material into the drafts queue.
 *
 * extract_materials.py reads the bill of materials off ISO drawing PDFs and
 * writes one CSV per run, a row per material line, each naming the drawing it
 * came from. A run covering forty drawings therefore becomes forty draft FMRs,
 * one per drawing, rather than one enormous one.
 *
 * Every row carries the confidence the extractor gave it and the reasons that
 * confidence was reduced. Low-confidence rows are not rejected — they are
 * carried through as warnings against the exact line, so a person can see what
 * the extractor was unsure about and fix it in the review screen.
 */

import { parseCsv } from '../../migrate/src/index.js';
import { normalizeIso, normalizeSheet, normalizeQuantity, normalizeSize, inferUom } from './normalize.js';
import { SEVERITY } from './extract.js';

/** Below this the extractor was guessing; the row is flagged for a person. */
const REVIEW_THRESHOLD = 0.65;

const clean = (v) => String(v ?? '').trim();

/**
 * Turn an extraction CSV into one proposed FMR per drawing.
 *
 * @param {string} csvText  contents of materials.csv
 * @param {object} options
 * @param {number} options.minConfidence  drop rows below this entirely
 * @returns {{ sheets: Array, summary: object }} shaped like extractWorkbook
 */
export function groupExtractedRows(csvText, { minConfidence = 0 } = {}) {
  const rows = parseCsv(csvText);
  const byDrawing = new Map();
  let dropped = 0;

  for (const [index, row] of rows.entries()) {
    const confidence = Number(row.confidence ?? 1);
    if (confidence < minConfidence) {
      dropped++;
      continue;
    }

    const isoNumber = normalizeIso(row.iso_number);
    if (!isoNumber) {
      dropped++;
      continue;
    }

    // A drawing's material may span several pages of the same PDF.
    const key = isoNumber;
    if (!byDrawing.has(key)) {
      byDrawing.set(key, {
        sheetName: isoNumber,
        header: {
          isoNumber,
          isoSheet: normalizeSheet(row.sheet ?? row.iso_sheet) ?? '01',
          sourceFile: row.source_pdf ?? null
        },
        lines: [],
        issues: []
      });
    }

    const drawing = byDrawing.get(key);
    const lineNumber = drawing.lines.length + 1;

    // Normalised here rather than left as text: the columns these land in are
    // numeric, and a blank quantity is a null, not an empty string.
    const quantity = normalizeQuantity(row.quantity);
    const description = clean(row.description);
    const { uom, rule } = inferUom(description, row.uom, row.quantity);

    // Where to look when the extractor got it wrong. The CSV row is what a
    // person can actually open and check, so that is what this points at —
    // `index + 2` because the header is row 1 and a spreadsheet counts from 1.
    // page_number was used here once, which is a different question entirely
    // (which page of the PDF) and is null for any CSV not written by
    // extract_materials.py — so every row's anchor was blank, and issues could
    // never highlight the line that caused them.
    drawing.lines.push({
      lineNumber,
      sourceRow: index + 2,
      pageNumber: Number(row.page_number) || null,
      itemNo: clean(row.item_no) || null,
      commodityCode: clean(row.commodity_code) || null,
      size: normalizeSize(row.size),
      description: description || null,
      quantity,
      uom,
      uomRule: rule,
      storageLocation: null,
      category: clean(row.category) || null,
      confidence
    });

    // A line with no quantity cannot become material to go and find, so this
    // blocks publishing until someone supplies it.
    if (quantity == null) {
      drawing.issues.push({
        severity: SEVERITY.ERROR,
        code: 'NO_QUANTITY',
        message: `Line ${lineNumber}: no quantity could be read from `
          + `"${clean(row.quantity)}". Enter one before publishing.`,
        row: lineNumber,
        sourceRow: index + 2
      });
    }

    // The extractor's own doubts, carried to the line they belong to.
    if (confidence < REVIEW_THRESHOLD) {
      drawing.issues.push({
        severity: SEVERITY.WARNING,
        code: 'LOW_CONFIDENCE',
        message:
          `Line ${lineNumber}: the extractor was unsure — ` +
          `${row.warnings || 'no reason given'} (confidence ${confidence.toFixed(2)}).`,
        row: lineNumber,
        sourceRow: index + 2,
        value: row.raw_text ?? null
      });
    }
  }

  const sheets = [...byDrawing.values()];

  return {
    sheets,
    summary: {
      sheets: sheets.length,
      lines: sheets.reduce((total, s) => total + s.lines.length, 0),
      errors: 0,
      warnings: sheets.reduce((total, s) => total + s.issues.length, 0),
      droppedRows: dropped
    }
  };
}

/**
 * A short account of what an extraction run found, for the review screen.
 *
 * Written in the terms a person cares about — drawings, lines, and how much
 * needs looking at — rather than the extractor's internals.
 */
export function describeExtraction(summary) {
  const parts = [
    `${summary.sheets} drawing${summary.sheets === 1 ? '' : 's'}`,
    `${summary.lines} material line${summary.lines === 1 ? '' : 's'}`
  ];

  if (summary.warnings) {
    parts.push(`${summary.warnings} line${summary.warnings === 1 ? '' : 's'} to check`);
  }
  if (summary.droppedRows) {
    parts.push(`${summary.droppedRows} row${summary.droppedRows === 1 ? '' : 's'} skipped`);
  }

  return parts.join(', ');
}
