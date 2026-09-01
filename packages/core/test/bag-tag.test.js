/**
 * Bag tag numbering.
 *
 * FMRv3 issued these itself and the crew never typed one (FieldService.gs:731).
 * The new system briefly required one by hand, which is slow in gloves and
 * invites the duplicate the UNIQUE constraint then rejects — after the typing.
 *
 * The counter itself needs a row lock and is tested against Postgres; what is
 * checked here is the shape of the number the crew writes on the bag, and the
 * parsing that lets a migrated project resume its own numbering.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatBagTagNumber, parseBagTagNumber, BAG_TAG_PATTERN
} from '../src/domain/bagTag.js';

test('a tag number reads as prefix, year and a padded counter', () => {
  assert.equal(formatBagTagNumber('BT', 2026, 1), 'BT-2026-00001');
  assert.equal(formatBagTagNumber('BT', 2026, 42), 'BT-2026-00042');
});

test('padding holds the width steady so a stack of tags sorts by eye', () => {
  const numbers = [1, 9, 10, 99, 100].map((n) => formatBagTagNumber('BT', 2026, n));
  const widths = new Set(numbers.map((n) => n.length));
  assert.equal(widths.size, 1, 'every tag number is the same length');
  assert.deepEqual([...numbers].sort(), numbers, 'sorting as text matches sorting as numbers');
});

test('a counter past five digits grows rather than being truncated', () => {
  // Better a wider tag than two bags sharing a number.
  assert.equal(formatBagTagNumber('BT', 2026, 123456), 'BT-2026-123456');
});

test('a project may use its own prefix', () => {
  assert.equal(formatBagTagNumber('GC', 2026, 7), 'GC-2026-00007');
});

test('a tag this system issued reads back into its parts', () => {
  assert.deepEqual(parseBagTagNumber('BT-2026-00042'), {
    prefix: 'BT', year: 2026, sequence: 42
  });
});

test('a pre-printed tag is not mistaken for a counter', () => {
  // A crew bagging into a tag that came off a printer types whatever is on it.
  // Reading a counter out of that would reset the sequence to something wrong.
  assert.equal(parseBagTagNumber('PREPRINT-9'), null);
  assert.equal(parseBagTagNumber('YARD BAG 3'), null);
  assert.equal(parseBagTagNumber(''), null);
  assert.equal(parseBagTagNumber(null), null);
});

test('a tag is read the same however the crew typed it', () => {
  assert.deepEqual(parseBagTagNumber('  bt-2026-00042  '), {
    prefix: 'BT', year: 2026, sequence: 42
  });
});

test('what the formatter writes, the parser reads', () => {
  for (const sequence of [1, 7, 99, 12345]) {
    const parsed = parseBagTagNumber(formatBagTagNumber('BT', 2026, sequence));
    assert.equal(parsed.sequence, sequence);
    assert.equal(parsed.year, 2026);
    assert.equal(parsed.prefix, 'BT');
  }
});

test('the pattern matches the migration that resumes a project numbering', () => {
  // 006_bag_tag_sequence.sql uses this same shape to find the highest counter
  // already in a project's history. If the two drift, a migrated project
  // reissues numbers its own bags already carry.
  assert.ok(BAG_TAG_PATTERN.test('BT-2026-00003'));
  assert.ok(BAG_TAG_PATTERN.test('GC-2026-41'));
  assert.ok(!BAG_TAG_PATTERN.test('PREPRINT-X'));
  assert.ok(!BAG_TAG_PATTERN.test('BT-26-00003'), 'the year is four digits');
});
