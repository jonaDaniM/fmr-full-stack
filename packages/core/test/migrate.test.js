/**
 * Migration safety.
 *
 * The point of these tests is that a bad row is *found*, not imported. A
 * spreadsheet lets quantities drift out of agreement; the database will not,
 * so the drift has to surface during migration rather than as a constraint
 * violation halfway through a load.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, validateLine } from '../../migrate/src/index.js';

test('parses a plain export', () => {
  const rows = parseCsv('A,B\n1,2\n3,4\n');
  assert.deepEqual(rows, [{ A: '1', B: '2' }, { A: '3', B: '4' }]);
});

test('handles quoted fields, commas and quotes inside them', () => {
  const rows = parseCsv('Desc,Qty\n"PIPE, CS A106, 6""",120\n');
  assert.equal(rows[0].Desc, 'PIPE, CS A106, 6"');
  assert.equal(rows[0].Qty, '120');
});

test('handles a newline inside a quoted field', () => {
  const rows = parseCsv('Note,N\n"line one\nline two",5\n');
  assert.equal(rows[0].Note, 'line one\nline two');
  assert.equal(rows.length, 1);
});

test('skips blank rows and tolerates a missing trailing newline', () => {
  const rows = parseCsv('A,B\n1,2\n\n3,4');
  assert.equal(rows.length, 2);
});

test('an empty export yields nothing rather than throwing', () => {
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv('A,B\n'), []);
});

const line = (over = {}) => ({
  FMR_Number: 'FMR-1', Line_Number: '1', ISO_Number: 'D-4410', ISO_Sheet: '01',
  Qty_Requested: '100', Qty_Confirmed_Located: '40', Qty_Active_Bagged: '10',
  Qty_Available: '20', Qty_Issued: '10', Qty_Pending_Backorder: '0',
  Qty_Confirmed_Backorder: '0', ...over
});

test('a sound row passes', () => {
  assert.deepEqual(validateLine(line()), []);
});

test('quantities that do not add up are caught', () => {
  // located 40, but available + bagged + issued = 45
  const problems = validateLine(line({ Qty_Available: '25' }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /located 40 does not equal/);
});

test('issuing more than requested is caught', () => {
  const problems = validateLine(line({
    Qty_Requested: '10', Qty_Confirmed_Located: '20',
    Qty_Available: '0', Qty_Active_Bagged: '0', Qty_Issued: '20'
  }));
  assert.ok(problems.some((p) => /issued 20 exceeds requested 10/.test(p)));
});

test('negative quantities are caught', () => {
  const problems = validateLine(line({
    Qty_Confirmed_Located: '-5', Qty_Available: '-15'
  }));
  assert.ok(problems.some((p) => /negative/.test(p)));
});

test('missing drawing identity is caught', () => {
  const problems = validateLine(line({ ISO_Number: '', ISO_Sheet: '  ' }));
  assert.ok(problems.some((p) => /ISO number is missing/.test(p)));
  assert.ok(problems.some((p) => /ISO sheet is missing/.test(p)));
});

test('a zero requested quantity is caught', () => {
  assert.ok(validateLine(line({
    Qty_Requested: '0', Qty_Confirmed_Located: '0', Qty_Available: '0',
    Qty_Active_Bagged: '0', Qty_Issued: '0'
  })).some((p) => /zero or missing/.test(p)));
});

test('thousands separators in exported numbers are read correctly', () => {
  assert.deepEqual(validateLine(line({
    Qty_Requested: '1,200', Qty_Confirmed_Located: '1,000',
    Qty_Available: '600', Qty_Active_Bagged: '200', Qty_Issued: '200'
  })), []);
});

test('fractional quantities stay in agreement', () => {
  assert.deepEqual(validateLine(line({
    Qty_Requested: '10.5', Qty_Confirmed_Located: '3.75',
    Qty_Available: '1.25', Qty_Active_Bagged: '2.5', Qty_Issued: '0'
  })), []);
});
