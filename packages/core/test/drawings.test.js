/**
 * Turning a scanned IWP package into draft FMRs.
 *
 * The payloads here are shaped like what `iso_bom.fmr_json` prints, with the
 * values taken from the 20 real LP1Y drawings in Archive/SamplePDFS — 203
 * material rows, including the reducer sizes and foot-marked pipe quantities
 * that the normalisers exist to handle.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { toDraftSheets, describePackage, reviewReasonIssues }
  from '../../import/src/drawings.js';

/** A payload with one drawing, whose material rows are given. */
const payload = (materials, extra = {}) => ({
  iwpNumber: 'IWP-88-014',
  pdfsDiscovered: 1,
  drawings: [{
    drawingNumber: 'LP1Y-CHWR-033047-02',
    revision: '2',
    page: 1,
    sourcePdf: 'LP1Y-CHWR-033047-02_R2.PDF',
    reviewReasons: [],
    materials,
    ...extra
  }],
  quarantine: []
});

const row = (over = {}) => ({
  pointNumber: '1',
  description: 'TEE STD WT STL A234 WPB',
  nominalSize: '16X16',
  commodityCode: '5374123',
  quantity: '1',
  reviewReasons: [],
  ...over
});

test('each drawing becomes one draft, numbered from its own material', () => {
  const { sheets, summary } = toDraftSheets({
    iwpNumber: 'IWP-88-014',
    pdfsDiscovered: 2,
    drawings: [
      { drawingNumber: 'LP1Y-CHWR-033047-02', revision: '2', page: 1,
        sourcePdf: 'a.PDF', materials: [row(), row({ pointNumber: '2' })] },
      { drawingNumber: 'LP1Y-AWNP-037002-04', revision: '1', page: 1,
        sourcePdf: 'b.PDF', materials: [row()] }
    ],
    quarantine: []
  });

  assert.equal(sheets.length, 2, 'two drawings, two drafts');
  assert.deepEqual(sheets[0].lines.map((l) => l.lineNumber), [1, 2]);
  assert.equal(sheets[1].lines.length, 1);
  assert.equal(summary.lines, 3);
  assert.equal(summary.iwpNumber, 'IWP-88-014', 'the package names itself');
});

test('the drawing number and revision reach the header', () => {
  const { sheets } = toDraftSheets(payload([row()]));
  assert.equal(sheets[0].header.isoNumber, 'LP1Y-CHWR-033047-02');
  assert.equal(sheets[0].header.revision, '2');
  assert.equal(sheets[0].header.isoSheet, '01', 'one sheet per PDF unless told otherwise');
  assert.equal(sheets[0].header.sourceFile, 'LP1Y-CHWR-033047-02_R2.PDF');
});

test('pipe carrying a foot mark is measured, not counted', () => {
  // Real row: PIPE STD WT ERW STL A53-B, quantity "128.8'". Sending a crew to
  // find 128 lengths of pipe instead of 128 feet is the bug this prevents.
  const { sheets } = toDraftSheets(payload([
    row({ description: 'PIPE STD WT ERW STL A53-B', quantity: "128.8'", nominalSize: '16' })
  ]));

  const line = sheets[0].lines[0];
  assert.equal(line.quantity, 128.8);
  assert.equal(line.uom, 'FT');
});

test('a reducer keeps both of its bores', () => {
  // A weldolet reducing 16" to 2". Both bores survive and each is written the
  // way the rest of the system writes a size.
  const { sheets } = toDraftSheets(payload([row({ nominalSize: '16X2' })]));
  assert.equal(sheets[0].lines[0].size, '16"x2"');
});

test('a missing quantity blocks publishing; a missing code does not', () => {
  const { sheets, summary } = toDraftSheets(payload([
    row({ quantity: '', reviewReasons: ['missing_quantity'] }),
    row({ pointNumber: '2', commodityCode: '', reviewReasons: ['missing_commodity_code'] })
  ]));

  const issues = sheets[0].issues;
  const blocking = issues.find((i) => i.code === 'MISSING_QUANTITY');
  assert.equal(blocking.severity, 'error', 'nobody can find "some" of something');

  const doubt = issues.find((i) => i.code === 'MISSING_COMMODITY_CODE');
  assert.equal(doubt.severity, 'warning', 'a description is still searchable');

  assert.equal(summary.errors, 1);
  assert.equal(summary.linesToCheck, 2, 'both lines want a person to look');
});

test('a drawing proposes an FMR number, and says that it did', () => {
  // A drawing carries no FMR number. One is proposed from the drawing so the
  // reviewer has something to accept or change, and flagged so it is never
  // published as though the office had chosen it.
  const { sheets } = toDraftSheets(payload([row()]));
  assert.equal(sheets[0].header.fmrNumber, 'LP1Y-CHWR-033047-02');
  assert.equal(sheets[0].header.iwpNumber, 'IWP-88-014', 'the package names it');

  const flag = sheets[0].issues.find((i) => i.code === 'PROPOSED_FMR_NUMBER');
  assert.equal(flag.severity, 'warning', 'a proposal does not block publishing');
});

test('a whole-drawing note is not counted as a line to check', () => {
  // "2 lines to check" over a table of 2 clean lines would be a lie.
  const { summary } = toDraftSheets(payload([row(), row({ pointNumber: '2' })]));
  assert.equal(summary.linesToCheck, 0);
  assert.ok(summary.warnings > 0, 'the proposed number is still reported');
});

test('an issue anchors to the same row as the line it is about', () => {
  // The review screen highlights the offending row by matching sourceRow
  // against a line's. Different numbers mean nothing is ever highlighted.
  const { sheets } = toDraftSheets(payload([
    row(),
    row({ pointNumber: '2', quantity: '', reviewReasons: ['missing_quantity'] })
  ]));

  const issue = sheets[0].issues.find((i) => i.code === 'MISSING_QUANTITY');
  const line = sheets[0].lines[1];
  assert.equal(issue.sourceRow, line.sourceRow, 'the anchors agree');
  // The drawing prints "2" against that BOM row, so that is what to look for.
  assert.equal(issue.sourceRow, '2');
});

test('a line points at the number printed on the drawing', () => {
  // BOM point numbers are what someone checking the sheet reads. They usually
  // run 1, 2, 3 — but when they do not, following the drawing beats counting.
  const { sheets } = toDraftSheets(payload([
    row({ pointNumber: '7' }), row({ pointNumber: '9' })
  ]));
  assert.deepEqual(sheets[0].lines.map((l) => l.sourceRow), ['7', '9']);
  assert.deepEqual(sheets[0].lines.map((l) => l.lineNumber), [1, 2]);
});

test('a drawing with no material is reported, not silently empty', () => {
  const { sheets, summary } = toDraftSheets(payload([]));
  const blocking = sheets[0].issues.find((i) => i.code === 'NO_MATERIAL');
  assert.ok(blocking, 'an empty drawing is not the same as one asking for nothing');
  assert.equal(blocking.severity, 'error');
  assert.equal(summary.errors, 1);
});

test('a drawing with no number is skipped rather than staged unsearchable', () => {
  const { sheets, summary } = toDraftSheets({
    drawings: [{ drawingNumber: '', materials: [row()] },
               { drawingNumber: 'LP1Y-NG-034031-02', materials: [row()] }],
    quarantine: []
  });
  assert.equal(sheets.length, 1);
  assert.equal(summary.droppedRows, 1);
});

test('a page the parser set aside is still reported', () => {
  const { sheets, summary } = toDraftSheets({
    drawings: [{ drawingNumber: 'LP1Y-NG-034031-02', materials: [row()] }],
    quarantine: [{
      source_pdf: 'weld-log.PDF',
      reason_code: 'ocr_required',
      reason_detail: 'image_or_sparse_text_page'
    }]
  });

  const set = sheets[0].issues.find((i) => i.code === 'OCR_REQUIRED');
  assert.ok(set, 'a page nobody read must not vanish');
  assert.match(set.message, /weld-log\.PDF/);
  assert.equal(summary.quarantined, 1);
});

test('a reason nobody wrote copy for still reaches the reviewer', () => {
  const [issue] = reviewReasonIssues(['some_new_reason'], 4);
  assert.equal(issue.severity, 'warning');
  assert.match(issue.message, /some_new_reason/);
  assert.equal(issue.row, 4);
});

test('the package is described in the terms a person cares about', () => {
  const { summary } = toDraftSheets(payload([
    row(), row({ pointNumber: '2', quantity: '', reviewReasons: ['missing_quantity'] })
  ]));
  assert.equal(describePackage(summary),
    '1 drawing, 2 material lines, 1 line to check — about a minute of typing');
});

test('the hours it replaced are reported, and read as a person would say them', () => {
  // The case for this system is made in hours, so the hours are part of what
  // the import screen says. Never "about 1 minutes".
  const one = toDraftSheets(payload([row()])).summary.timeSaved;
  assert.equal(one.available, true);
  assert.match(describePackage(toDraftSheets(payload([row()])).summary), /about a minute/);

  // Jonathan's real package: 51 drawings, 329 rows.
  const big = toDraftSheets({
    drawings: Array.from({ length: 51 }, (_, i) => ({
      drawingNumber: `LP131-AI(100)-8520${String(i).padStart(2, '0')}`,
      materials: Array.from({ length: 6 }, () => row())
    })),
    quarantine: []
  }).summary;
  assert.equal(big.timeSaved.drawings, 51);
  assert.ok(big.timeSaved.seconds > 5000, 'hours, not minutes');
});

test('nothing read is not the same as nothing saved', () => {
  const { summary } = toDraftSheets({ drawings: [], quarantine: [] });
  assert.equal(summary.timeSaved.available, false);
  assert.equal(summary.timeSaved.seconds, null, 'not zero — unknown');
});

/**
 * A package that yields nothing has to say what it did contain.
 *
 * The office uploaded a 51-page package where the first isometric is page 17
 * — the pages before it are a cover, sixteen weld logs and six pipe-support
 * sheets. That package reads fine. But a package that is *only* those pages
 * failed with "No drawings were found in those files", of a file plainly full
 * of drawings, and the conclusion drawn was that the parser was broken rather
 * than that the wrong PDF had been picked.
 */
test('a package with nothing stageable says what it did hold', () => {
  const { summary } = toDraftSheets({
    drawings: [],
    pdfsDiscovered: 1,
    quarantine: [
      { source_pdf: 'combined.pdf', reason_code: 'WELD_LOG', reason_detail: 'weld log' },
      { source_pdf: 'combined.pdf', reason_code: 'COVER', reason_detail: 'cover sheet' }
    ]
  });

  assert.equal(summary.sheets, 0);
  assert.equal(summary.quarantined, 2,
    'the set-aside pages are the only account of where the package went');
});

test('a drawing with no readable number is counted, not silently lost', () => {
  const { sheets, summary } = toDraftSheets({
    drawings: [
      { drawingNumber: '', materials: [{ description: 'PIPE', quantity: '10' }] },
      { drawingNumber: 'D-4410-01', materials: [{ description: 'PIPE', quantity: '10' }] }
    ]
  });

  assert.equal(sheets.length, 1, 'the readable drawing still stages');
  assert.equal(summary.droppedRows, 1, 'and the unreadable one is reported, not dropped quietly');
  assert.match(describePackage(summary), /1 drawing skipped/);
});
