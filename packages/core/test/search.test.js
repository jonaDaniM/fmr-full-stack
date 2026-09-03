import test from 'node:test';
import assert from 'node:assert/strict';
import { isoCandidates } from '../src/domain/isoKey.js';

test('a bare drawing number is searched as typed', () => {
  assert.deepEqual(isoCandidates('D-1234'), ['D-1234']);
});

test('a two-digit suffix is also read as a sheet number', () => {
  const out = isoCandidates('D-1234-05');
  assert.ok(out.includes('D-1234-05'), 'could still be the drawing itself');
  assert.ok(out.includes('D-1234|05'), 'or drawing D-1234, sheet 05');
  assert.ok(out.includes('D-1234|5'), 'sheet 5 and 05 are the same to a human');
});

test('an explicit iso key is left alone', () => {
  assert.deepEqual(isoCandidates('D-1234|05'), ['D-1234|05']);
  assert.deepEqual(isoCandidates('D-1234 SHT 5'), ['D-1234 SHT 5']);
});

test('the ISO: prefix is stripped', () => {
  assert.ok(isoCandidates('ISO:D-1234-05').includes('D-1234|05'));
});

test('input is normalised and blanks handled', () => {
  assert.deepEqual(isoCandidates('  d-1234  '), ['D-1234']);
  assert.deepEqual(isoCandidates(''), []);
  assert.deepEqual(isoCandidates(null), []);
});

// --- sheet numbers as they are actually written ---------------------------
//
// Every case above uses a two-digit sheet, which is how the fixtures were
// written and not how the drawings are: of the 684 real drawing sheets on the
// project, 628 have a single-digit one. Matching only two digits meant a crew
// typing the drawing the way it appears on the sheet got nothing back for 91%
// of the lines they work from.

test('a single-digit suffix is read as a sheet number too', () => {
  const out = isoCandidates('LP131-SC-824001-5');
  assert.ok(out.includes('LP131-SC-824001|5'), 'drawing LP131-SC-824001, sheet 5');
  assert.ok(out.includes('LP131-SC-824001-5'), 'could still be the drawing itself');
});

test('both readings are offered, so a guess costs nothing', () => {
  // A drawing whose number genuinely ends in -7 still matches as itself; the
  // query tries every candidate and takes whichever exists.
  const out = isoCandidates('D-1234-7');
  assert.deepEqual(out, ['D-1234-7', 'D-1234|7']);
});

test('three digits are not a sheet number', () => {
  // Sheets do not run to three digits, and reading one that way would split a
  // drawing number that happens to end in a run of digits.
  assert.deepEqual(isoCandidates('D-1234-005'), ['D-1234-005']);
});
