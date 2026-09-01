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
