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
  takeoffCsv, groupBySheet, takeoffDocument, takeoffFilename, takeoffSheetFor,
  TAKEOFF_SHEETS
} from '../../import/src/mto.js';

const row = (over = {}) => ({
  cwa: '10D', iwp: 'IWP-88-014', lineNumber: 'LP131-P-108060', sheet: '04',
  pipeSpec: '332', description: 'PIPE SCH 40 ERW STL A53-B', size: '6',
  commodityCode: '5356648', quantity: '49.2', uom: 'LF',
  itemType: 'PIPE', takeoffSheet: 'PIPE & FITTINGS', ...over
});

test('the header is the takeoff form\'s own columns, in its order', () => {
  // Checked against the client's real filled-in workbook, not inferred. The
  // three paint columns are blank in every example seen, but they are on the
  // form, and a missing column shifts everything after it on paste.
  const [header] = takeoffCsv([]).split('\r\n');
  assert.equal(header,
    '"CWA","IWP","LINE NUMBER","SHEET","PIPE SPEC","DESCRIPTION",'
    + '"SIZE","COMMODITY CODE","QTY","UOM",'
    + '"EPIC PAINT CODE","CUST. PAINT CODE","COLOR"');
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

test('material is routed to the sheet that quotes it', () => {
  // Ported from the client's own material_category_sheet, order included.
  assert.equal(takeoffSheetFor('PIPE', 'PIPE SCH 40 ERW STL A53-B'), 'PIPE & FITTINGS');
  assert.equal(takeoffSheetFor('BOLT', 'STUD BOLT B7 W/ 2H NUTS'), 'BOLTS & GASKETS');
  assert.equal(takeoffSheetFor('GASKET', 'GASKET SPIRAL WOUND'), 'BOLTS & GASKETS');
  assert.equal(takeoffSheetFor('SUPPORT', '5UG, U-BOLT GUIDE'), 'SUPPORTS');
  assert.equal(takeoffSheetFor('', 'BIRDSCREEN 316 SS 45 DEG'), 'BIRDSCREENS');
  assert.equal(takeoffSheetFor('', 'BALL 1000# CWP BW 316SS'), 'VALVES');
  assert.equal(takeoffSheetFor('', 'BLIND FLANGE 150#'), 'BLINDS');
});

test('a blind is a blind before it is anything else', () => {
  // The client tests blinds first. A "BLIND FLANGE" routed as a fitting is
  // quoted by the wrong supplier.
  assert.equal(takeoffSheetFor('FITTING', 'BLIND FLANGE 150# RF A105'), 'BLINDS');
});

test('a ball valve is a valve, not a fitting', () => {
  assert.equal(takeoffSheetFor('FITTING', 'BALL 1000# CWP BW 316SS TFE'), 'VALVES');
});

test('a support whose description names pipe is still a support', () => {
  // Every one of these is real, from the client's newFmr36 package, and every
  // one of them landed on the pipe buyer's sheet: the descriptions name the
  // pipe the hardware holds. Same fault that once sent 344 rows of hardware
  // to be quoted by the foot — the commodity code decides, not the words.
  const supports = [
    ['5SH-1', '5SH, SPACER FOR PIPE SIZE 20" AND SMALLER'],
    ['5S2M3L-12', '5S2, WELDED SHOE LONG, SS, 3" HIGH, 12" PIPE'],
    ['5DA2-M', '5DA2, DIRECTIONAL ANCHOR, SS, FOR PIPE SIZE 12" - 54" NPD'],
    ['5ISC-06-02', '5ISC, INSULATED SUPPORT COLD SERV, 6" PIPE W/ 2" INSUL'],
    ['5BG1-2', '5BG1, CLAMP ON GUIDE BERNECKER, SIZE CODE 2'],
    ['5MG1S-1', '5MG1S, MODULAR GUIDE, STEEL SIZE CODE 1'],
    ['5CH-02-15', '5CH, SUPPORT CRADLE HOT SERVICE 2" PIPE, 1-1/2" INS']
  ];

  for (const [code, description] of supports) {
    assert.equal(takeoffSheetFor('SPECIALTY', description, code), 'SUPPORTS',
      `${code} was quoted by the wrong supplier`);
  }
});

test('actual pipe still reaches the pipe buyer', () => {
  // The guard above must not swallow the material it sits next to.
  assert.equal(
    takeoffSheetFor('PIPE', 'PIPE SCH 40 ERW STL A53-B', '5356648'),
    'PIPE & FITTINGS'
  );
  assert.equal(
    takeoffSheetFor('FITTING', 'SOCKOLET 3000# STL A105', '5532671'),
    'PIPE & FITTINGS'
  );
});

test('COMBINED holds every row, and the category sheets sort them', () => {
  const grouped = groupBySheet([
    row({ itemType: 'PIPE', description: 'PIPE SCH 40 ERW STL A53-B' }),
    row({ itemType: 'BOLT', description: 'STUD BOLT B7' }),
    row({ itemType: 'SUPPORT', description: '5UG, U-BOLT GUIDE' })
  ]);

  assert.equal(grouped.get('COMBINED').length, 3, 'COMBINED is the whole takeoff');
  assert.equal(grouped.get('PIPE & FITTINGS').length, 1);
  assert.equal(grouped.get('BOLTS & GASKETS').length, 1);
  assert.equal(grouped.get('SUPPORTS').length, 1);
});

test('every sheet appears even when the package has none of that material', () => {
  // A buyer needs to see there are no bolts, not wonder whether the sheet
  // failed to generate.
  const grouped = groupBySheet([row()]);
  assert.deepEqual([...grouped.keys()], [...TAKEOFF_SHEETS]);
});

test('a row in no known category still reaches the buyer', () => {
  const grouped = groupBySheet([
    row({ itemType: 'MYSTERY', description: 'SOMETHING UNFAMILIAR' })
  ]);
  assert.equal(grouped.get('OTHER MATERIALS').length, 1,
    'an unclassified row would otherwise be bought by nobody');
  assert.equal(grouped.get('COMBINED').length, 1, 'and it is still on COMBINED');
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
