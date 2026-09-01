/**
 * Normalisation against real takeoff output.
 *
 * These cases come from 140 FMR workbooks the takeoff toolkit generated from
 * Jonathan's ISO drawings — 1,472 material rows. Every value here was taken
 * from that set, not invented, and each one broke something before it was
 * fixed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSize, normalizeQuantity, inferUom, quantityLooksMeasured
} from '../../import/src/normalize.js';

test('pipe quantities carry a foot mark', () => {
  // Before this was handled, every pipe line failed outright — and pipe is
  // the highest-value material on a drawing.
  assert.equal(normalizeQuantity("49.2'"), 49.2);
  assert.equal(normalizeQuantity("0.3'"), 0.3);
  assert.equal(normalizeQuantity("77.0'"), 77);
  assert.equal(normalizeQuantity("1.9'"), 1.9);
});

test('a foot mark means the line is measured, not counted', () => {
  assert.ok(quantityLooksMeasured("49.2'"));
  assert.equal(quantityLooksMeasured('24'), false);
  assert.equal(quantityLooksMeasured(''), false);
});

test('reducing fittings carry both bores', () => {
  // A 1x3/4 tee, a 12x8 reducer. Each side normalises on its own.
  assert.equal(normalizeSize('1X3/4'), '1"x3/4"');
  assert.equal(normalizeSize('2X1 1/2'), '2"x1-1/2"');
  assert.equal(normalizeSize('12X8'), '12"x8"');
  assert.equal(normalizeSize('2X1/2'), '2"x1/2"');
  assert.equal(normalizeSize('3/4X3/4'), '3/4"x3/4"');
});

test('plain sizes from real drawings still normalise', () => {
  assert.equal(normalizeSize('1'), '1"');
  assert.equal(normalizeSize('3/4'), '3/4"');
  assert.equal(normalizeSize('1 1/2'), '1-1/2"');
  assert.equal(normalizeSize('5/8'), '5/8"');
});

test('a pipe support is counted, however much pipe it names', () => {
  // The single worst bug this data found: 344 rows of hardware were being
  // ordered in feet because the description mentions the pipe it holds.
  const supports = [
    '5UG, U-BOLT GUIDE FOR UNINSULATED LINES 2" PIPE',
    '5CI, ISOLATION CRADLE, 1" PIPE, SS',
    '5MUG, GUIDES, U-BOLT, PIPE SIZE 1" NPD',
    '5HR2T, TRAPEZE HANGER ROD W/ TURNBUCKLE, 10" AND SMALLER',
    '5HR4T, HANGER ROD CLEVIS TYPE W/ TURNBUCKLE, 1" PIPE',
    '5G2, GUIDE, 48" TO SMALLER PIPE WITH SHOE',
    '5ABS3, T-SHAPED BASE SUPPORT, FOR PIPE SIZE 6" NPD',
    '5SH, SPACER FOR PIPE SIZE 20" AND SMALLER'
  ];

  for (const description of supports) {
    assert.equal(inferUom(description, '', '2').uom, 'EA',
      `"${description.slice(0, 40)}" should be counted`);
  }
});

test('a fitting sized against a pipe is counted', () => {
  const fittings = [
    'TEE RED 3000# SW 316/316L SS',
    'ELL 90 DEG 3000# SW 316/316L SS',
    'COUPLING 3000# SW 316/316L SS',
    'NIPPLE SCH 10S 316/316L SS PBE 3" LONG',
    'PLUG ROUND HEAD SCRD 316/316L SS',
    'BALL 1440# CWP SW X FNPT 316 SS',
    'HOSE CONNECTION 316 SS BW ADAPTER CAMLOCK'
  ];

  for (const description of fittings) {
    assert.equal(inferUom(description, '', '1').uom, 'EA',
      `"${description.slice(0, 40)}" should be counted`);
  }
});

test('actual pipe is measured in feet', () => {
  assert.equal(inferUom('PIPE SCH 10S ERW 316/316L SS A312 NSF', '', "49.2'").uom, 'FT');
  assert.equal(inferUom('PIPE SCH 40 SMLS CS A106 GR B', '', "12.5'").uom, 'FT');
});

test('the quantity mark outranks the description', () => {
  // If the takeoff wrote a foot mark, it measured it, whatever the wording.
  const result = inferUom('SOMETHING UNFAMILIAR', '', "18.5'");
  assert.equal(result.uom, 'FT');
  assert.equal(result.rule, 'measured quantity');
});

test('a stated unit still wins over everything', () => {
  assert.equal(inferUom('PIPE SCH 40', 'EA', "49.2'").uom, 'EA');
});
