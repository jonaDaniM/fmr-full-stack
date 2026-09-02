/**
 * Bringing extracted drawing material into the drafts queue.
 *
 * Rows come out of extract_materials.py one per material line, each naming its
 * drawing. A run covering many drawings becomes many draft FMRs — one per
 * drawing — because that is the unit a crew works from.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { groupExtractedRows, describeExtraction } from '../../import/src/extracted.js';

const HEADER = 'source_pdf,page_number,iso_number,category,item_no,commodity_code,' +
               'size,quantity,description,remarks,raw_text,confidence,warnings';

const csv = (...rows) => [HEADER, ...rows].join('\n');

test('rows are grouped into one draft per drawing', () => {
  const { sheets, summary } = groupExtractedRows(csv(
    'a.pdf,1,6820-R2-61007-01,PIPE,1,PS401,10,1,PIPE SUPPORT,,raw,1.0,',
    'a.pdf,1,6820-R2-61007-01,PIPE,2,PS204,10,2,ANOTHER,,raw,1.0,',
    'b.pdf,1,6820-R2-61019-01,PIPE,1,PS206,8,1,THIRD,,raw,1.0,'
  ));

  assert.equal(sheets.length, 2, 'two drawings, two drafts');
  assert.equal(sheets[0].header.isoNumber, '6820-R2-61007-01');
  assert.equal(sheets[0].lines.length, 2);
  assert.equal(sheets[1].lines.length, 1);
  assert.equal(summary.lines, 3);
});

test('lines are numbered within their own drawing', () => {
  const { sheets } = groupExtractedRows(csv(
    'a.pdf,1,D-1,PIPE,7,C1,2,1,FIRST,,raw,1.0,',
    'a.pdf,2,D-1,PIPE,9,C2,2,1,SECOND,,raw,1.0,'
  ));
  assert.deepEqual(sheets[0].lines.map((l) => l.lineNumber), [1, 2],
    'the drawing numbers its own lines, not the extractor');
});

test('every line points back at the row of the CSV it came from', () => {
  // Two drawings interleaved, so a line's position in its drawing and its
  // position in the file are different numbers — which is the whole point.
  const { sheets } = groupExtractedRows(csv(
    'a.pdf,1,D-1,PIPE,1,C1,2,1,FIRST,,raw,1.0,',
    'b.pdf,1,D-2,PIPE,1,C2,2,1,OTHER DRAWING,,raw,1.0,',
    'a.pdf,1,D-1,PIPE,2,C3,2,1,SECOND,,raw,1.0,'
  ));

  // Row 1 is the header, so the first data row is row 2 — what a person sees
  // when they open the file to check it.
  assert.deepEqual(sheets[0].lines.map((l) => l.sourceRow), [2, 4],
    'the second line of D-1 is the fourth row of the file');
  assert.deepEqual(sheets[1].lines.map((l) => l.sourceRow), [3]);
});

test('an issue anchors to the same row as the line it is about', () => {
  // The review screen marks the offending row by matching an issue's sourceRow
  // against a line's. They were once different numbers, so nothing ever matched
  // and a low-confidence row could not be highlighted.
  const { sheets } = groupExtractedRows(csv(
    'a.pdf,1,D-1,PIPE,1,C1,2,1,GOOD,,raw,1.0,',
    'a.pdf,1,D-1,PIPE,2,C2,2,1,DOUBTFUL,,raw,0.55,smudged'
  ));

  const doubt = sheets[0].issues.find((i) => i.code === 'LOW_CONFIDENCE');
  const line = sheets[0].lines.find((l) => l.description === 'DOUBTFUL');
  assert.equal(doubt.sourceRow, line.sourceRow, 'the anchors agree');
  assert.equal(doubt.sourceRow, 3);
});

test('the page of the PDF is kept, and is not the source row', () => {
  // page_number was once used as the source row. It answers a different
  // question and is absent from any CSV not written by extract_materials.py.
  const { sheets } = groupExtractedRows(csv(
    'a.pdf,7,D-1,PIPE,1,C1,2,1,ON PAGE SEVEN,,raw,1.0,'
  ));
  assert.equal(sheets[0].lines[0].pageNumber, 7);
  assert.equal(sheets[0].lines[0].sourceRow, 2);
});

test("the extractor's doubts follow the line they belong to", () => {
  const { sheets } = groupExtractedRows(csv(
    'a.pdf,1,D-1,PIPE,1,C1,2,1,GOOD ROW,,raw,1.0,',
    'a.pdf,1,D-1,PIPE,2,,,,,,"wrapped text",0.55,no quantity; no size'
  ));

  const issues = sheets[0].issues;
  assert.ok(issues.every((i) => i.row === 2), 'every issue points at the doubtful line');

  const doubt = issues.find((i) => i.code === 'LOW_CONFIDENCE');
  assert.ok(doubt, 'the confidence itself is reported');
  assert.match(doubt.message, /no quantity; no size/, 'saying what the extractor found');
  assert.match(doubt.message, /0\.55/);

  // No quantity is not just doubt — the line cannot become material to find.
  const blocking = issues.find((i) => i.code === 'NO_QUANTITY');
  assert.ok(blocking, 'a missing quantity blocks publishing');
  assert.equal(blocking.severity, 'error');
});

test('a confident row raises nothing', () => {
  const { sheets, summary } = groupExtractedRows(csv(
    'a.pdf,1,D-1,PIPE,1,C1,2,1,FINE,,raw,0.95,'
  ));
  assert.equal(sheets[0].issues.length, 0);
  assert.equal(summary.warnings, 0);
});

test('a minimum confidence drops rows rather than flagging them', () => {
  const rows = csv(
    'a.pdf,1,D-1,PIPE,1,C1,2,1,KEEP,,raw,0.9,',
    'a.pdf,1,D-1,PIPE,2,C2,2,1,DROP,,raw,0.4,'
  );

  assert.equal(groupExtractedRows(rows).sheets[0].lines.length, 2, 'kept by default');

  const strict = groupExtractedRows(rows, { minConfidence: 0.65 });
  assert.equal(strict.sheets[0].lines.length, 1);
  assert.equal(strict.summary.droppedRows, 1);
});

test('a row with no drawing number cannot become an FMR', () => {
  const { sheets, summary } = groupExtractedRows(csv(
    'a.pdf,1,,PIPE,1,C1,2,1,ORPHAN,,raw,1.0,',
    'a.pdf,1,D-1,PIPE,1,C1,2,1,FINE,,raw,1.0,'
  ));
  assert.equal(sheets.length, 1);
  assert.equal(summary.droppedRows, 1);
});

test('drawing numbers and sheets are normalised on the way in', () => {
  const { sheets } = groupExtractedRows(csv(
    'a.pdf,1,  6820 r2 61007 01 ,PIPE,1,C1,2,1,X,,raw,1.0,'
  ));
  assert.equal(sheets[0].header.isoNumber, '6820-R2-61007-01');
  assert.equal(sheets[0].header.isoSheet, '01', 'defaults when the drawing does not say');
});

test('material spanning several pages stays one drawing', () => {
  const { sheets } = groupExtractedRows(csv(
    'a.pdf,1,D-1,PIPE,1,C1,2,1,PAGE ONE,,raw,1.0,',
    'a.pdf,2,D-1,PIPE,2,C2,2,1,PAGE TWO,,raw,1.0,'
  ));
  assert.equal(sheets.length, 1);
  assert.equal(sheets[0].lines.length, 2);
});

test('the summary reads as a person would say it', () => {
  assert.equal(
    describeExtraction({ sheets: 12, lines: 340, warnings: 3, droppedRows: 0 }),
    '12 drawings, 340 material lines, 3 lines to check'
  );
  assert.equal(
    describeExtraction({ sheets: 1, lines: 1, warnings: 0, droppedRows: 0 }),
    '1 drawing, 1 material line'
  );
});

test('an empty extraction is not an error', () => {
  const { sheets, summary } = groupExtractedRows(csv());
  assert.deepEqual(sheets, []);
  assert.equal(summary.lines, 0);
});
