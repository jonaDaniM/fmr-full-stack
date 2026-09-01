/**
 * Draft validation.
 *
 * The distinction that matters: someone typing up a requisition can stop
 * halfway and come back, so saving records gaps rather than refusing them.
 * Publishing refuses, because the crews work from what is published.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDraft, parsePastedLines, SEVERITY } from '../../import/src/validate.js';

const draft = (over = {}) => ({
  header: {
    fmrNumber: 'FMR-2026-0417', iwpNumber: 'IWP-88-014',
    isoNumber: 'D-4410', isoSheet: '01', requestedBy: 'Dale Hughes',
    priority: 'High', ...over.header
  },
  lines: over.lines ?? [
    { commodityCode: 'PF-A106', size: '6"', description: 'PIPE, CS A106 GR B', quantity: '120' }
  ]
});

const errors = (result) => result.issues.filter((i) => i.severity === SEVERITY.ERROR);

test('a complete draft passes both passes', () => {
  assert.ok(validateDraft(draft()).valid);
  assert.ok(validateDraft(draft(), { requireFmrNumber: true }).valid);
});

test('a draft without a number saves, but will not publish', () => {
  const half = draft({ header: { fmrNumber: '' } });

  assert.ok(validateDraft(half).valid, 'still being typed up');

  const strict = validateDraft(half, { requireFmrNumber: true });
  assert.equal(strict.valid, false);
  assert.ok(errors(strict).some((e) => e.code === 'NO_FMR_NUMBER'));
});

test('a drawing number and sheet are required either way', () => {
  const result = validateDraft(draft({ header: { isoNumber: '', isoSheet: '' } }));
  assert.equal(result.valid, false);
  assert.ok(errors(result).some((e) => e.code === 'NO_ISO'));
  assert.ok(errors(result).some((e) => e.code === 'NO_SHEET'));
});

test('an FMR with no material lines is refused', () => {
  const result = validateDraft(draft({ lines: [] }));
  assert.ok(errors(result).some((e) => e.code === 'NO_LINES'));
});

test('a missing IWP is a warning, not a blocker', () => {
  const result = validateDraft(draft({ header: { iwpNumber: '' } }));
  assert.ok(result.valid);
  assert.ok(result.issues.some((i) => i.code === 'NO_IWP' && i.severity === SEVERITY.WARNING));
});

test('quantities are checked per line and named by line', () => {
  const result = validateDraft(draft({
    lines: [
      { description: 'PIPE', quantity: '10' },
      { description: 'ELBOW', quantity: 'TBD' },
      { description: 'FLANGE', quantity: '0' }
    ]
  }));

  const bad = errors(result);
  assert.ok(bad.some((e) => e.code === 'BAD_QUANTITY' && e.lineNumber === 2));
  assert.ok(bad.some((e) => e.code === 'ZERO_QUANTITY' && e.lineNumber === 3));
  assert.match(bad.find((e) => e.lineNumber === 2).message, /^Line 2:/);
});

test('a line with no description is refused', () => {
  const result = validateDraft(draft({ lines: [{ description: '', quantity: '5' }] }));
  assert.ok(errors(result).some((e) => e.code === 'NO_DESCRIPTION'));
});

test('hand-typed values normalise the same as imported ones', () => {
  const { normalized } = validateDraft(draft({
    header: { isoNumber: '  d 4410 ', isoSheet: 'SHT 1' },
    lines: [
      { description: 'PIPE, CS A106', size: '1-1/2', quantity: '1,200' },
      { description: 'ELBOW 90 LR', size: '2-Jan', quantity: '18' }
    ]
  }));

  assert.equal(normalized.header.isoNumber, 'D-4410');
  assert.equal(normalized.header.isoSheet, '01');
  assert.equal(normalized.lines[0].size, '1-1/2"');
  assert.equal(normalized.lines[0].quantity, 1200);
  assert.equal(normalized.lines[0].uom, 'FT', 'pipe is measured in feet');
  assert.equal(normalized.lines[1].size, '1/2"', 'recovered from Excel date mangling');
  assert.equal(normalized.lines[1].uom, 'EA');
});

test('lines are numbered by position', () => {
  const { normalized } = validateDraft(draft({
    lines: [
      { description: 'A', quantity: '1' },
      { description: 'B', quantity: '2' }
    ]
  }));
  assert.deepEqual(normalized.lines.map((l) => l.lineNumber), [1, 2]);
});

test('a date that cannot be read becomes null rather than an invalid date', () => {
  assert.equal(validateDraft(draft({ header: { dateRequired: 'whenever' } }))
    .normalized.header.dateRequired, null);
  assert.equal(validateDraft(draft({ header: { dateRequired: '2026-09-15' } }))
    .normalized.header.dateRequired, '2026-09-15');
});

// --- pasted input

test('a tab-separated paste from a spreadsheet is read', () => {
  const lines = parsePastedLines(
    'PF-A106\t6"\tPIPE, CS A106\t120\tFT\tRack 12\n' +
    'EL90\t6"\tELBOW 90 LR\t18\tEA\tRack 12'
  );
  assert.equal(lines.length, 2);
  assert.equal(lines[0].commodityCode, 'PF-A106');
  assert.equal(lines[0].description, 'PIPE, CS A106');
  assert.equal(lines[1].quantity, '18');
});

test('a comma-separated paste is read too', () => {
  const lines = parsePastedLines('PF-A106,6",PIPE,120,FT');
  assert.equal(lines[0].commodityCode, 'PF-A106');
});

test('a header row that came along with the paste is skipped', () => {
  const lines = parsePastedLines(
    'Commodity Code\tSize\tDescription\tQty\tUOM\n' +
    'PF-A106\t6"\tPIPE, CS A106\t120\tFT'
  );
  assert.equal(lines.length, 1);
  assert.equal(lines[0].commodityCode, 'PF-A106');
});

test('blank lines and empty pastes are handled', () => {
  assert.equal(parsePastedLines('A\t1\n\n\nB\t2').length, 2);
  assert.deepEqual(parsePastedLines(''), []);
  assert.deepEqual(parsePastedLines(null), []);
});
