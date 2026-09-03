/**
 * Pasting a block of a takeoff into a draft must not lose a line.
 *
 * The split happens only in the browser — the server is handed line objects,
 * never the pasted text — so a row dropped here is a row nothing downstream
 * can warn about. It does not appear as an error, or as a validation issue on
 * the draft. The line count simply reads one lower than what was pasted, and
 * material nobody ordered goes missing on site.
 *
 * The header guess was the way to lose one. It asked whether the first row
 * *mentions* commodity / code / desc / qty, and real pipe-support descriptions
 * do: "5MG1, MODULAR GUIDE, SIZE CODE 1" is a part, not a heading, and 170
 * lines of the live project carry one of those words. Every case below with a
 * SIZE CODE in it is a real description taken from the project database.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parsePaste, looksLikeHeading } from '../../web/public/lib/paste.js';

/** Real descriptions from the live project, all carrying a trigger word. */
const REAL_DESCRIPTIONS = [
  '5MHR4, MODULAR HANGER ROD, SIZE CODE 2, 1" NPD',
  '5MG1, MODULAR GUIDE, SIZE CODE 1, 1/2" TO 24" NPD ( See support detail for additional hardware)',
  '5BSG, GUIDED BASE SUPPORT ASSEMBLY, SIZE CODE 3)  (SEE SUPPORT DETAIL)',
  '5MHR1, MODULAR HANGER ROD, SIZE CODE 1, 1" NPD',
  '5BG1, CLAMP ON GIDE BERNECKER, SIZE CODE 2 ( See support detail for additional hardware)'
];

const row = (code, description) => [code, '1"', description, '4', 'EA', 'Rack 3'].join('\t');

test('a real pipe support is a material line, not a heading', () => {
  for (const description of REAL_DESCRIPTIONS) {
    const lines = parsePaste(row('PS-5MG1', description));
    assert.equal(lines.length, 1, `lost the line for: ${description}`);
    assert.equal(lines[0].description, description);
    assert.equal(lines[0].quantity, '4');
  }
});

test('a pipe support first in the block does not eat itself', () => {
  // The failing shape: paste three lines, the first being a support.
  const pasted = [
    row('PS-5MG1', '5MG1, MODULAR GUIDE, SIZE CODE 1'),
    row('PF-A106', 'PIPE, CS A106 GR B'),
    row('EL90', 'ELBOW 90 LR')
  ].join('\n');

  const lines = parsePaste(pasted);
  assert.equal(lines.length, 3, 'a material line was swallowed as a heading');
  assert.equal(lines[0].commodityCode, 'PS-5MG1');
});

test('a real heading row is still skipped', () => {
  const pasted = [
    ['Commodity Code', 'Size', 'Description', 'Qty', 'UOM', 'Location'].join('\t'),
    row('PF-A106', 'PIPE, CS A106 GR B')
  ].join('\n');

  const lines = parsePaste(pasted);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].commodityCode, 'PF-A106');
});

test('headings are recognised however they are worded', () => {
  assert.ok(looksLikeHeading(['Code', 'Size', 'Description', 'Qty', 'UOM', 'Location']));
  assert.ok(looksLikeHeading(['ITEM NO.', 'NPD', 'DESCRIPTION', 'QUANTITY', 'U/M']));
  assert.ok(looksLikeHeading(['commodity code', 'bore', 'material', 'quant', 'unit']));
});

test('one cell of real data means it is a line', () => {
  // Safe direction: a heading mistaken for a line shows the reviewer an
  // obviously wrong row to delete; a line mistaken for a heading is gone.
  assert.equal(looksLikeHeading(['Code', 'Size', 'Description', '120', 'UOM']), false);
  assert.equal(looksLikeHeading(['PF-A106', '6"', 'PIPE, CS A106', '120', 'FT']), false);
  assert.equal(looksLikeHeading(['PS-1', '1"', 'GUIDE, SIZE CODE 1', '4', 'EA']), false);
});

test('a single cell is never a heading', () => {
  // One word could be either; treating it as a heading would drop the only row.
  assert.equal(looksLikeHeading(['Description']), false);
  assert.equal(looksLikeHeading([]), false);
});

test('tabs keep a description that contains commas', () => {
  // Excel pastes tab-separated, and these descriptions are full of commas.
  const description = '5MHR1, MODULAR HANGER ROD, SIZE CODE 1, 1" NPD';
  const [line] = parsePaste(row('PS-5MHR1', description));
  assert.equal(line.description, description);
  assert.equal(line.uom, 'EA');
});

test('blank lines and trailing whitespace are ignored', () => {
  const pasted = `\n  ${row('PF-A106', 'PIPE, CS A106')}  \n\n`;
  assert.equal(parsePaste(pasted).length, 1);
  assert.equal(parsePaste('').length, 0);
  assert.equal(parsePaste(null).length, 0);
});
