/**
 * Turning a scanned IWP package into draft FMRs.
 *
 * `iso_bom.fmr_json` reads a folder of drawing PDFs and prints what it found:
 * one entry per ISO sheet, each carrying its material rows and the reasons the
 * parser was unsure about any of them. This turns that into the same shape the
 * workbook and CSV importers produce, so it enters the drafts queue through
 * `stageWorkbook`'s `preExtracted` seam and is reviewed by the same screen.
 *
 * Nothing here touches the filesystem or the database — the payload goes in,
 * draft sheets come out — so the rules can be tested without a PDF or Postgres.
 */

import {
  normalizeIso, normalizeSheet, normalizeQuantity, normalizeSize, inferUom
} from './normalize.js';
import { SEVERITY } from './extract.js';

const clean = (v) => String(v ?? '').trim();

/**
 * What each reason the parser gives back means for a reviewer.
 *
 * A missing quantity is the only one that blocks publishing: nobody can be
 * sent to find "some" of something. The rest are worth a person's eye but do
 * not stop a crew being given the line — an unnamed commodity code still has a
 * description to search by.
 */
const REASONS = {
  missing_quantity: {
    severity: SEVERITY.ERROR,
    say: 'no quantity was read from the drawing'
  },
  missing_description: {
    severity: SEVERITY.ERROR,
    say: 'no description was read from the drawing'
  },
  missing_commodity_code: {
    severity: SEVERITY.WARNING,
    say: 'no commodity code was read'
  },
  missing_nominal_size: {
    severity: SEVERITY.WARNING,
    say: 'no size was read'
  },
  duplicate_bom_point_number: {
    severity: SEVERITY.WARNING,
    say: 'two rows share this point number'
  },
  multiple_commodity_code_candidates: {
    severity: SEVERITY.WARNING,
    say: 'more than one commodity code was possible'
  },
  multiple_quantity_candidates: {
    severity: SEVERITY.WARNING,
    say: 'more than one quantity was possible'
  }
};

/** A reason nobody has written copy for still has to reach the reviewer. */
function describeReason(reason) {
  return REASONS[reason] ?? {
    severity: SEVERITY.WARNING,
    say: `the parser reported "${reason}"`
  };
}

/**
 * One material row's doubts, as issues anchored to the line they belong to.
 *
 * Both `row` and `sourceRow` are set to the same number. The review screen
 * matches an issue to its line by `sourceRow`, so an issue carrying a
 * different one cannot highlight anything.
 */
export function reviewReasonIssues(reasons, lineNumber) {
  return (reasons ?? []).map((reason) => {
    const { severity, say } = describeReason(reason);
    return {
      severity,
      code: reason.toUpperCase(),
      message: `Line ${lineNumber}: ${say}.`,
      row: lineNumber,
      sourceRow: lineNumber
    };
  });
}

/** One drawing's material, as draft lines plus whatever needs checking. */
function toSheet(drawing, iwpNumber) {
  const isoNumber = normalizeIso(drawing.drawingNumber);
  const lines = [];
  const issues = [];

  for (const material of drawing.materials ?? []) {
    const lineNumber = lines.length + 1;
    const description = clean(material.description);

    // The parser hands back what it read, as text. Everything numeric or
    // dimensional goes through the shared normalisers — a quantity of "138.4'"
    // is 138.4 feet, and "16X16" is a reducer with two bores. Those rules were
    // each a bug found against a real drawing; do not restate them here.
    const quantity = normalizeQuantity(material.quantity);
    const { uom, rule } = inferUom(description, null, material.quantity);

    lines.push({
      lineNumber,
      sourceRow: lineNumber,
      pointNumber: clean(material.pointNumber) || null,
      commodityCode: clean(material.commodityCode) || null,
      size: normalizeSize(material.nominalSize),
      description: description || null,
      quantity,
      uom,
      uomRule: rule,
      storageLocation: null,
      category: null,
      confidence: null
    });

    issues.push(...reviewReasonIssues(material.reviewReasons, lineNumber));
  }

  // A page the parser could not read is not silently dropped: a drawing that
  // reaches the queue with nothing on it would otherwise look like a drawing
  // that genuinely asks for nothing.
  for (const reason of drawing.reviewReasons ?? []) {
    const { say } = describeReason(reason);
    issues.push({
      severity: SEVERITY.WARNING,
      code: reason.toUpperCase(),
      message: `This drawing needs checking: ${say}.`,
      row: null,
      sourceRow: null
    });
  }

  if (!lines.length) {
    issues.push({
      severity: SEVERITY.ERROR,
      code: 'NO_MATERIAL',
      message: 'No material was read from this drawing. Check it before publishing.',
      row: null,
      sourceRow: null
    });
  }

  // A drawing does not carry an FMR number — the office issues those. One is
  // proposed from the drawing so the reviewer has something to accept or edit
  // rather than an empty box, and it is flagged either way: publishing under a
  // number nobody chose is how two FMRs end up meaning the same thing.
  const fmrNumber = isoNumber;
  issues.push({
    severity: SEVERITY.WARNING,
    code: 'PROPOSED_FMR_NUMBER',
    message: `This FMR is proposed as ${fmrNumber}, after the drawing. `
      + 'Change it if the office numbers these differently.',
    row: null,
    sourceRow: null
  });

  return {
    sheetName: isoNumber,
    header: {
      fmrNumber,
      iwpNumber: iwpNumber || null,
      isoNumber,
      // Each PDF here is one sheet of its own drawing, so unless the number
      // says otherwise this is sheet 01 — the same default the workbook
      // importer applies.
      isoSheet: normalizeSheet(drawing.sheet) ?? '01',
      revision: clean(drawing.revision) || null,
      sourceFile: clean(drawing.sourcePdf) || null,
      sourcePage: Number(drawing.page) || null
    },
    lines,
    issues
  };
}

/**
 * Turn a scan of an IWP package into draft sheets, one per drawing.
 *
 * @param {object} payload  what `iso_bom.fmr_json` printed
 * @returns {{ sheets: Array, summary: object }} shaped like groupExtractedRows
 */
export function toDraftSheets(payload) {
  const drawings = payload?.drawings ?? [];
  const iwpNumber = clean(payload?.iwpNumber);
  const sheets = [];
  let dropped = 0;

  for (const drawing of drawings) {
    // Without a drawing number there is nothing to search against later, and
    // the ISO key the ledger indexes by cannot be built.
    if (!normalizeIso(drawing.drawingNumber)) {
      dropped++;
      continue;
    }
    sheets.push(toSheet(drawing, iwpNumber));
  }

  // Pages the parser set aside — a weld log, an image-only sheet needing OCR.
  // They belong on the batch rather than on any one drawing.
  const quarantine = (payload?.quarantine ?? []).map((entry) => ({
    severity: SEVERITY.WARNING,
    code: clean(entry.reason_code).toUpperCase() || 'QUARANTINED',
    message: `${clean(entry.source_pdf) || 'A page'}: `
      + `${clean(entry.reason_detail) || clean(entry.reason_code) || 'set aside by the parser'}.`,
    row: null,
    sourceRow: null
  }));

  if (quarantine.length && sheets.length) {
    sheets[0].issues.push(...quarantine);
  }

  const count = (severity) => sheets.reduce(
    (total, sheet) => total + sheet.issues.filter((i) => i.severity === severity).length, 0);

  // "lines to check" has to mean lines. An issue about the whole drawing — a
  // proposed FMR number, a page set aside — is not one, and counting it makes
  // the sentence say something untrue about the table underneath it.
  const linesToCheck = new Set();
  for (const sheet of sheets) {
    for (const issue of sheet.issues) {
      if (issue.sourceRow != null) linesToCheck.add(`${sheet.sheetName}:${issue.sourceRow}`);
    }
  }

  return {
    sheets,
    summary: {
      sheets: sheets.length,
      lines: sheets.reduce((total, s) => total + s.lines.length, 0),
      errors: count(SEVERITY.ERROR),
      warnings: count(SEVERITY.WARNING),
      linesToCheck: linesToCheck.size,
      droppedRows: dropped,
      iwpNumber: clean(payload?.iwpNumber) || null,
      pdfsDiscovered: Number(payload?.pdfsDiscovered) || 0,
      quarantined: (payload?.quarantine ?? []).length
    }
  };
}

/**
 * A short account of what a package held, for the review screen.
 *
 * Written in the terms a person cares about — drawings, lines, and how much
 * needs looking at — rather than the parser's internals.
 */
export function describePackage(summary) {
  const parts = [
    `${summary.sheets} drawing${summary.sheets === 1 ? '' : 's'}`,
    `${summary.lines} material line${summary.lines === 1 ? '' : 's'}`
  ];

  const toCheck = summary.linesToCheck ?? 0;
  if (toCheck) parts.push(`${toCheck} line${toCheck === 1 ? '' : 's'} to check`);
  if (summary.quarantined) {
    parts.push(`${summary.quarantined} page${summary.quarantined === 1 ? '' : 's'} set aside`);
  }
  if (summary.droppedRows) {
    parts.push(`${summary.droppedRows} drawing${summary.droppedRows === 1 ? '' : 's'} skipped`);
  }

  return parts.join(', ');
}
