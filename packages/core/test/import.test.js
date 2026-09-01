/**
 * Import extraction.
 *
 * The normalisation rules here were learned from real files. The date-mangling
 * cases in particular are not hypothetical: Excel converts 1/2" to 2-Jan on
 * open, and a crew sent to find "2-Jan" of pipe finds nothing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSize, fractionFromDateText, inferUom, normalizeQuantity,
  normalizeIso, normalizeSheet
} from '../../import/src/normalize.js';
import {
  findLabeledValue, findTableHeader, extractSheet, SEVERITY
} from '../../import/src/extract.js';
import { readFileSync } from 'node:fs';

const profile = JSON.parse(
  readFileSync(new URL('../../import/profiles/default.json', import.meta.url))
);

// --- sizes -----------------------------------------------------------------

test('plain sizes normalise consistently', () => {
  assert.equal(normalizeSize('6'), '6"');
  assert.equal(normalizeSize('6"'), '6"');
  assert.equal(normalizeSize('6 IN'), '6"');
  assert.equal(normalizeSize(' 12 '), '12"');
});

test('fractions normalise consistently', () => {
  assert.equal(normalizeSize('1/2'), '1/2"');
  assert.equal(normalizeSize('3/4"'), '3/4"');
  assert.equal(normalizeSize('1-1/2'), '1-1/2"');
  assert.equal(normalizeSize('1 1/2"'), '1-1/2"');
});

test('decimals that are really fractions are converted back', () => {
  assert.equal(normalizeSize('1.5'), '1-1/2"');
  assert.equal(normalizeSize('0.75'), '3/4"');
  assert.equal(normalizeSize('2.25'), '2-1/4"');
});

test('sizes Excel turned into dates are recovered', () => {
  // 1/2" opened in Excel becomes 2-Jan
  assert.equal(fractionFromDateText('2-Jan'), '1/2');
  assert.equal(fractionFromDateText('4-Mar'), '3/4');
  assert.equal(fractionFromDateText('8-May'), '5/8');
  assert.equal(fractionFromDateText('Jan-2'), '1/2');
  assert.equal(normalizeSize('2-Jan'), '1/2"');
  assert.equal(normalizeSize('4-Mar'), '3/4"');
});

test('a real date object in a size column is recovered too', () => {
  assert.equal(fractionFromDateText(new Date(2026, 0, 2)), '1/2');
});

test('a genuine date is not mistaken for a fraction', () => {
  // day <= month cannot be a fraction in lowest terms
  assert.equal(fractionFromDateText('1-Mar'), null);
  assert.equal(fractionFromDateText('12-Dec'), null);
});

test('a reducing size is read as both its bores', () => {
  // Written this way on real drawings for tees and reducers.
  assert.equal(normalizeSize('6 x 4'), '6"x4"');
});

test('unreadable sizes are preserved rather than dropped', () => {
  assert.equal(normalizeSize('SEE DETAIL'), 'SEE DETAIL');
  assert.equal(normalizeSize(''), null);
  assert.equal(normalizeSize(null), null);
});

// --- uom -------------------------------------------------------------------

test('length material is measured in feet, not each', () => {
  assert.equal(inferUom('PIPE, CS A106 GR B, SMLS').uom, 'FT');
  assert.equal(inferUom('TUBING, SS').uom, 'FT');
  assert.equal(inferUom('CABLE, 3C 12AWG').uom, 'FT');
});

test('fittings and valves are counted', () => {
  assert.equal(inferUom('ELBOW 90 LR, A234 WPB').uom, 'EA');
  assert.equal(inferUom('VALVE, BALL, 150#').uom, 'EA');
  assert.equal(inferUom('FLANGE, WN, A105').uom, 'EA');
});

test('a stated uom always wins over inference', () => {
  const result = inferUom('PIPE, CS A106', 'ea');
  assert.equal(result.uom, 'EA');
  assert.equal(result.rule, 'stated');
});

// --- quantities and identifiers --------------------------------------------

test('quantities tolerate separators and trailing units', () => {
  assert.equal(normalizeQuantity('1,200'), 1200);
  assert.equal(normalizeQuantity('40 FT'), 40);
  assert.equal(normalizeQuantity('12.5'), 12.5);
  assert.equal(normalizeQuantity('abc'), null);
  assert.equal(normalizeQuantity(''), null);
});

test('drawing numbers and sheets normalise', () => {
  assert.equal(normalizeIso('  d-4410 '), 'D-4410');
  assert.equal(normalizeIso('D 4410'), 'D-4410');
  assert.equal(normalizeSheet('1'), '01');
  assert.equal(normalizeSheet('SHT 3'), '03');
  assert.equal(normalizeSheet('Sheet 12'), '12');
});

// --- extraction ------------------------------------------------------------

const GRID = [
  ['FIELD MATERIAL REQUISITION', '', '', '', ''],
  ['FMR No:', 'FMR-2026-0417', '', 'IWP No:', 'IWP-88-014'],
  ['Drawing No:', 'D-4410', '', 'Sheet:', '01'],
  ['Requested By:', 'Dale Hughes', '', 'Priority:', 'High'],
  ['', '', '', '', ''],
  ['Item', 'Commodity Code', 'Size', 'Description', 'Qty'],
  ['1', 'PF-A106-STD', '6"', 'PIPE, CS A106 GR B, SMLS, STD', '120'],
  ['2', 'EL90-A234', '2-Jan', 'ELBOW 90 LR, A234 WPB, BW', '18'],
  ['3', 'FLWN-A105', '1.5', 'FLANGE, WN, A105, 150#, RF', '1,200'],
  ['', '', '', '', ''],
  ['', '', '', 'TOTAL', '1338']
];

test('a labelled header value is found beside its label', () => {
  assert.equal(findLabeledValue(GRID, ['FMR No']).value, 'FMR-2026-0417');
  assert.equal(findLabeledValue(GRID, ['Drawing No']).value, 'D-4410');
  assert.equal(findLabeledValue(GRID, ['Sheet']).value, '01');
  assert.equal(findLabeledValue(GRID, ['Nothing Here']), null);
});

test('the material table is located by its heading row', () => {
  const table = findTableHeader(GRID, profile.columns);
  assert.equal(table.row, 5);
  assert.equal(table.columns.description, 3);
  assert.equal(table.columns.quantity, 4);
  assert.equal(table.columns.size, 2);
});

test('a whole sheet extracts, normalising as it goes', () => {
  const { header, lines, issues } = extractSheet(GRID, profile, 'Sheet1');

  assert.equal(header.fmrNumber, 'FMR-2026-0417');
  assert.equal(header.isoNumber, 'D-4410');
  assert.equal(header.isoSheet, '01');

  assert.equal(lines.length, 3, 'the totals row is not a material line');

  assert.equal(lines[0].size, '6"');
  assert.equal(lines[0].quantity, 120);
  assert.equal(lines[0].uom, 'FT', 'pipe is measured in feet');

  assert.equal(lines[1].size, '1/2"', 'recovered from Excel turning it into 2-Jan');
  assert.equal(lines[1].uom, 'EA', 'an elbow is counted');

  assert.equal(lines[2].size, '1-1/2"');
  assert.equal(lines[2].quantity, 1200, 'thousands separator handled');

  assert.equal(issues.filter((i) => i.severity === SEVERITY.ERROR).length, 0);
});

test('a sheet with no table is reported, not thrown', () => {
  const { issues, lines } = extractSheet([['nothing', 'here']], profile, 'Blank');
  assert.equal(lines.length, 0);
  assert.ok(issues.some((i) => i.code === 'NO_TABLE'));
});

test('a bad quantity is reported against its row', () => {
  const grid = [
    ['FMR No:', 'FMR-1'], ['Drawing No:', 'D-1', '', 'Sheet:', '01'], [''],
    ['Item', 'Description', 'Qty'],
    ['1', 'PIPE, CS', 'TBD']
  ];
  const { issues } = extractSheet(grid, profile, 'S');
  const problem = issues.find((i) => i.code === 'BAD_QUANTITY');
  assert.ok(problem);
  assert.match(problem.message, /"TBD" is not a number/);
});

test('a missing required header is reported', () => {
  const grid = [
    ['Drawing No:', 'D-1', '', 'Sheet:', '01'], [''],
    ['Item', 'Description', 'Qty'], ['1', 'PIPE', '10']
  ];
  const { issues } = extractSheet(grid, profile, 'S');
  assert.ok(issues.some((i) => i.code === 'MISSING_HEADER' && i.field === 'fmrNumber'));
});
