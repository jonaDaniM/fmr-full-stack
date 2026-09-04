/**
 * The Material Takeoff document.
 *
 * This is what the material team buys from, so the failure mode is not a
 * cosmetic one: a row in the wrong category is quoted by the wrong supplier,
 * and a quantity Excel reads as a date is ordered wrong.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  takeoffCsv, groupBySheet, takeoffDocument, takeoffFilename, TAKEOFF_SHEETS
} from '../../import/src/mto.js';

const row = (over = {}) => ({
  cwa: '10D', iwp: 'IWP-88-014', lineNumber: 'LP131-P-108060', sheet: '04',
  pipeSpec: '332', description: 'PIPE SCH 40 ERW STL A53-B', size: '6',
  commodityCode: '5356648', quantity: '49.2', uom: 'LF',
  itemType: 'PIPE', takeoffSheet: 'PIPE & FITTINGS', ...over
});

test('the header is the takeoff form\'s own columns, in its order', () => {
  const [header] = takeoffCsv([]).split('\r\n');
  assert.equal(header,
    '"CWA","IWP","LINE NUMBER","SHEET","PIPE SPEC","DESCRIPTION",'
    + '"SIZE","COMMODITY CODE","QTY","UOM"');
});

test('a commodity code is not turned into a date by Excel', () => {
  // The same damage that turns 3/4" into 4-Mar on the way in. Every non-empty
  // cell is quoted, so the buyer's spreadsheet reads them as text.
  const csv = takeoffCsv([row({ commodityCode: '1-2', size: '3/4' })]);
  assert.match(csv, /"1-2"/);
  assert.match(csv, /"3\/4"/);
});

test('a description containing a quote does not break the row', () => {
  const csv = takeoffCsv([row({ description: 'U-BOLT FOR 2" PIPE' })]);
  assert.match(csv, /"U-BOLT FOR 2"" PIPE"/);
  assert.equal(csv.split('\r\n').length, 2, 'the row split itself in two');
});

test('material is grouped by where it is bought', () => {
  const grouped = groupBySheet([
    row({ takeoffSheet: 'PIPE & FITTINGS' }),
    row({ takeoffSheet: 'BOLTS & GASKETS' }),
    row({ takeoffSheet: 'BOLTS & GASKETS' }),
    row({ takeoffSheet: 'COMBINED' })
  ]);
  assert.equal(grouped.get('PIPE & FITTINGS').length, 1);
  assert.equal(grouped.get('BOLTS & GASKETS').length, 2);
  assert.equal(grouped.get('COMBINED').length, 1);
});

test('every sheet appears even when the package has none of that material', () => {
  // A buyer needs to see there are no bolts, not wonder whether the sheet
  // failed to generate.
  const grouped = groupBySheet([row()]);
  assert.deepEqual([...grouped.keys()], [...TAKEOFF_SHEETS]);
});

test('a row in no known category still reaches the buyer', () => {
  const grouped = groupBySheet([row({ takeoffSheet: 'NOT A SHEET' })]);
  assert.equal(grouped.get('COMBINED').length, 1,
    'an unclassified row would otherwise be bought by nobody');
});

test('the document names the package and counts what is in it', () => {
  const doc = takeoffDocument({
    rows: [row(), row({ takeoffSheet: 'BOLTS & GASKETS', itemType: 'BOLT' })],
    iwpNumber: 'IWP-88-014', cwa: '10D', drawings: 3, missingPipeSpec: 0
  });
  assert.match(doc, /"MATERIAL TAKEOFF"/);
  assert.match(doc, /"IWP-88-014"/);
  assert.match(doc, /"CWA 10D"/);
  assert.match(doc, /"3 drawings"/);
  assert.match(doc, /"2 lines"/);
  for (const sheet of TAKEOFF_SHEETS) assert.ok(doc.includes(`"${sheet}"`), sheet);
});

test('pipe with no schedule is called out at the top, not found at quoting', () => {
  const doc = takeoffDocument({
    rows: [row({ pipeSpec: '' })],
    iwpNumber: 'IWP-1', cwa: '', drawings: 1, missingPipeSpec: 1
  });
  assert.match(doc, /1 pipe line had no pipe schedule/);
});

test('a package with no material is refused rather than sent out empty', () => {
  assert.throws(
    () => takeoffDocument({ rows: [], iwpNumber: 'IWP-1', drawings: 0 }),
    (error) => error.code === 'NO_MATERIAL'
  );
});

test('the filename identifies the package in a folder of them', () => {
  assert.equal(takeoffFilename({ iwpNumber: 'IWP-88-014', cwa: '10D' }),
    'MTO 10D-IWP-88-014.csv');
  assert.equal(takeoffFilename({ iwpNumber: '', cwa: '' }), 'MTO package.csv');
});

test('a filename cannot carry a path out of the download folder', () => {
  const name = takeoffFilename({ iwpNumber: '../../etc/passwd', cwa: '' });
  assert.doesNotMatch(name, /[/\\]/, 'a separator would escape the folder');
  assert.equal(name, 'MTO .._.._etc_passwd.csv');
});
