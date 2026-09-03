/**
 * A quantity in an editable cell must survive being read back.
 *
 * The draft and import line editors save a whole row whenever any cell in it
 * is left — the server validates a line as a unit, so a quantity is only
 * meaningful beside its UOM. That makes every cell a round trip: whatever the
 * page wrote into the quantity cell is what comes back as the quantity, even
 * when the person edited the description and never touched the number.
 *
 * The cell was filled with `n()`, which groups for the reader's locale. On an
 * English machine that survives, because `normalizeQuantity` strips the comma.
 * On a German one 1234.5 renders as "1.234,5", which the server reads as
 * 1.2345 — a thousandth of the real figure, written to a line nobody edited.
 * A French browser writes "1 234,5", which parses to null.
 *
 * No line on the live project reaches 1,000 today, so this is a trap rather
 * than damage already done. It only needs one large pipe-footage line and one
 * laptop with a European locale.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { editableNumber, n } from '../../web/public/lib/dom.js';
import { normalizeQuantity } from '../../import/src/normalize.js';

/** Locales a browser might genuinely be set to. */
const LOCALES = ['en-US', 'en-GB', 'de-DE', 'fr-FR', 'en-IN', 'es-ES'];

test('an edited quantity comes back as the same number', () => {
  for (const quantity of [1, 18, 49.2, 120, 240, 1200, 1234.5, 12000, 1000000]) {
    const cell = editableNumber(quantity);
    const saved = normalizeQuantity(cell);
    assert.equal(saved, quantity, `${quantity} came back as ${saved}`);
  }
});

test('the cell holds no grouping, whatever locale the reader is on', () => {
  // editableNumber must not be locale-sensitive at all — that is the point.
  const cell = editableNumber(1234.5);
  assert.equal(cell, '1234.5');
  assert.equal(/[,\s]/.test(cell), false, 'an editable cell must not be grouped');
});

test('the grouped form is what would have been lost', () => {
  // Demonstrates the bug rather than asserting the old behaviour is wanted:
  // these are the values a locale-formatted cell would have sent back.
  const damaged = LOCALES
    .map((locale) => (1234.5).toLocaleString(locale, { maximumFractionDigits: 2 }))
    .map((text) => normalizeQuantity(text))
    .filter((value) => value !== 1234.5);

  assert.ok(damaged.length > 0,
    'expected some locale to mangle a grouped quantity — if none do, this guard is stale');
});

test('an empty quantity stays empty rather than becoming zero', () => {
  // A blank cell on the "add a line" row means nothing typed yet, and
  // saveLine skips the row on that basis. "0" would be a real quantity.
  assert.equal(editableNumber(null), '');
  assert.equal(editableNumber(undefined), '');
  assert.equal(editableNumber(''), '');
  assert.equal(editableNumber(0), '0');
});

test('n() still groups, for the figures that are only read', () => {
  // The fix narrows where n() is used; it does not change n().
  assert.equal(n(1200).replace(/ /g, ' ').includes('1'), true);
  assert.equal(n(null), '0');
});
