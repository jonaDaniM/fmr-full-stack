import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fitReport, likelyHeaderRow, suggestField, learnHeading, forgetHeading,
  validateProfile, ESSENTIAL
} from '../../import/src/profileFit.js';

const baseline = {
  headerSearchRows: 30,
  columns: {
    lineNumber: ['Item', 'Item No', 'Line'],
    commodityCode: ['Commodity Code', 'Commodity', 'Code'],
    size: ['Size', 'NPS', 'DN'],
    description: ['Description', 'Material Description', 'Desc'],
    quantity: ['Qty', 'Quantity', 'Qty Req'],
    uom: ['UOM', 'Unit'],
    storageLocation: ['Location', 'Bin']
  }
};

// A sheet the baseline reads perfectly.
const familiar = [
  ['GULF COAST TURNAROUND', '', '', '', ''],
  ['FMR No', 'FMR-1001', '', '', ''],
  [],
  ['Item', 'Commodity Code', 'Size', 'Description', 'Qty', 'UOM'],
  ['1', 'PP-A106', '2"', 'PIPE, CS A106', '120', 'FT']
];

// The same drawing from a different drafting office.
const unfamiliar = [
  ['MIDWEST EXPANSION — BILL OF MATERIAL', '', '', '', ''],
  [],
  ['Mark', 'Stock Code', 'NPD', 'Nomenclature', "Req'd Qty", 'U/M'],
  ['1', 'PP-A106', '2"', 'PIPE, CS A106', '120', 'FT']
];

test('a familiar sheet reports every column matched', () => {
  const report = fitReport(familiar, baseline);
  assert.equal(report.headerRow, 3);
  assert.equal(report.unmatched.length, 0);
  assert.equal(report.missing.length, 0);
  assert.ok(report.usable);
  assert.deepEqual(
    report.matched.map((m) => m.field).sort(),
    ['commodityCode', 'description', 'lineNumber', 'quantity', 'size', 'uom']
  );
});

test('an unfamiliar sheet names the headings it could not place', () => {
  // This is the whole point: the parser fails silently, the screen must not.
  const report = fitReport(unfamiliar, baseline);

  assert.equal(report.headerRow, 2);
  assert.ok(!report.usable, 'it cannot import as it stands');
  assert.deepEqual(report.missing.sort(), ['description', 'quantity']);

  const headings = report.unmatched.map((u) => u.heading);
  assert.ok(headings.includes("Req'd Qty"));
  assert.ok(headings.includes('Nomenclature'));
});

test('an unfamiliar heading is offered a suggestion, never applied silently', () => {
  const report = fitReport(unfamiliar, baseline);
  const byHeading = Object.fromEntries(
    report.unmatched.map((u) => [u.heading, u.suggestion])
  );

  assert.equal(byHeading["Req'd Qty"], 'quantity');
  assert.equal(byHeading['Nomenclature'], 'description');
  assert.equal(byHeading['Stock Code'], 'commodityCode');
  assert.equal(byHeading['NPD'], 'size');
  assert.equal(byHeading['U/M'], 'uom');
});

test('a heading nothing suggests itself for is reported as unknown', () => {
  assert.equal(suggestField('Zone'), null);
  assert.equal(suggestField(''), null);
});

test('a sheet whose headings are all unknown still finds the header row', () => {
  // Otherwise the screen has nothing to show and the person is stuck.
  const alien = [
    ['PROJECT X'], [],
    ['Aaa', 'Bbb', 'Ccc', 'Ddd'],
    ['1', '2', '3', '4']
  ];
  const header = likelyHeaderRow(alien, baseline.columns);
  assert.equal(header.row, 2);
  assert.equal(header.matched, 0);
  assert.equal(header.filled, 4);
});

test('learning a heading makes the next import match it exactly', () => {
  let profile = baseline;
  for (const [heading, field] of [
    ["Req'd Qty", 'quantity'], ['Nomenclature', 'description'],
    ['Stock Code', 'commodityCode'], ['NPD', 'size'],
    ['U/M', 'uom'], ['Mark', 'lineNumber']
  ]) {
    profile = learnHeading(profile, field, heading);
  }

  const report = fitReport(unfamiliar, profile);
  assert.ok(report.usable, 'the same sheet now imports');
  assert.equal(report.unmatched.length, 0);
  assert.equal(report.missing.length, 0);
});

test('learning does not mutate the profile it was given', () => {
  const before = JSON.stringify(baseline);
  learnHeading(baseline, 'quantity', "Req'd Qty");
  assert.equal(JSON.stringify(baseline), before);
});

test('learning a heading already known changes nothing', () => {
  const same = learnHeading(baseline, 'quantity', 'QTY');
  assert.equal(same, baseline, 'punctuation and case do not make it new');
});

test('a blank heading cannot be learned', () => {
  assert.throws(() => learnHeading(baseline, 'quantity', '   '), /cannot be blank/);
  assert.throws(() => learnHeading(baseline, '', 'Qty'), /Choose what this column holds/);
});

test('a heading mapped by mistake can be taken back off', () => {
  const learned = learnHeading(baseline, 'size', 'Zone');
  const fixed = forgetHeading(learned, 'size', 'Zone');
  assert.ok(!fixed.columns.size.includes('Zone'));
  assert.ok(fixed.columns.size.includes('NPS'), 'the rest survives');
});

test('a profile with no quantity or description column is refused', () => {
  // Saving it would hand the next person an empty batch and no reason for it.
  const broken = { columns: { size: ['Size'] } };
  const problems = validateProfile(broken);
  assert.equal(problems.length, 2);
  assert.ok(problems.some((p) => p.includes('quantity')));
  assert.ok(problems.some((p) => p.includes('description')));
});

test('a punctuation-only alias does not match every blank cell', () => {
  // The baseline maps "#" to the item number. Squashed to letters and digits
  // that is an empty string, which matched every empty cell in the sheet — so
  // a two-cell header block outscored the real heading row and the screen
  // offered "FMR-7001" as a column to map.
  const withHash = {
    ...baseline,
    columns: { ...baseline.columns, lineNumber: ['Item', '#'] }
  };

  const sheet = [
    ['MIDWEST EXPANSION — BILL OF MATERIAL'],
    ['FMR No', 'FMR-7001', '', '', '', ''],
    ['ISO No', 'D-5510', 'Sheet', '01', '', ''],
    ['', '', '', '', '', ''],
    ['Mark', 'Stock Code', 'NPD', 'Nomenclature', "Req'd Qty", 'U/M'],
    ['1', 'PP-A106', '2"', 'PIPE', '120', 'FT']
  ];

  const header = likelyHeaderRow(sheet, withHash.columns);
  assert.equal(header.row, 4, 'the row of column headings, not the header block');

  const report = fitReport(sheet, withHash);
  assert.equal(report.headerRow, 4);
  assert.ok(!report.unmatched.some((u) => u.heading === 'FMR-7001'),
    'a value is never offered as a column to map');
});

test('a heading that is only punctuation still matches itself', () => {
  const withHash = {
    ...baseline,
    columns: { ...baseline.columns, lineNumber: ['#'] }
  };
  const sheet = [['#', 'Description', 'Qty'], ['1', 'PIPE', '2']];
  const report = fitReport(sheet, withHash);
  assert.ok(report.matched.some((m) => m.field === 'lineNumber'));
});

test('a valid profile reports no problems', () => {
  assert.deepEqual(validateProfile(baseline), []);
});

test('an invalid stop pattern is caught before it is saved', () => {
  const problems = validateProfile({ ...baseline, stopPatterns: ['^total', '[unclosed'] });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /not a valid pattern/);
});

test('a blank alias is refused rather than silently ignored', () => {
  const problems = validateProfile({
    columns: { ...baseline.columns, size: ['Size', ''] }
  });
  assert.ok(problems.some((p) => p.includes('blank heading')));
});

test('the essential fields are the two an import cannot do without', () => {
  // A line with no quantity is not something a crew can be sent to find.
  assert.deepEqual([...ESSENTIAL].sort(), ['description', 'quantity']);
});

test('a duplicate heading maps once rather than twice', () => {
  const doubled = [
    ['Qty', 'Description', 'Quantity'],
    ['1', 'PIPE', '2']
  ];
  const report = fitReport(doubled, baseline);
  const quantities = report.matched.filter((m) => m.field === 'quantity');
  assert.equal(quantities.length, 1, 'the parser takes the first');
});

test('an empty sheet reports what is missing rather than throwing', () => {
  const report = fitReport([], baseline);
  assert.equal(report.headerRow, null);
  assert.ok(!report.usable);
  assert.deepEqual(report.missing.sort(), ['description', 'quantity']);
});
