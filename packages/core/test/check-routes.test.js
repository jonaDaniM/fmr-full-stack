/**
 * A failing check must lead somewhere.
 *
 * The owner's Health and Integrity tabs report counts — "2 backorders awaiting
 * a decision", "1 notice pointing at a request that is gone" — and until now
 * left the reader to work out which screen holds those rows.
 *
 * The routes are keyed on each check's `code` rather than its name, because
 * the names are sentences written for a person and will be rephrased. That
 * makes the codes an interface between the services and the owner screen, and
 * these check it holds: every code the map claims to route must be a code some
 * service actually emits, or the link is dead and nobody would notice.
 *
 * The reverse is deliberately not required. Several integrity checks describe
 * a disagreement between tables that no single screen owns, and inventing a
 * destination for those would send someone somewhere that cannot help.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { CHECK_DESTINATIONS, destinationFor } from '../../web/public/lib/checkRoutes.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = (file) => readFileSync(join(here, '../src/services', file), 'utf8');

/** Every `code:` a service hands to the owner screen. */
function codesIn(file) {
  return [...src(file).matchAll(/code:\s*'([A-Z_]+)'/g)].map((m) => m[1]);
}

test('every route points at a check some service actually reports', () => {
  const known = new Set([...codesIn('controls.js'), ...codesIn('integrity.js')]);

  for (const code of Object.keys(CHECK_DESTINATIONS)) {
    assert.ok(known.has(code),
      `${code} has a route but no service emits it — the link is dead`);
  }
});

test('the health checks all carry a code', () => {
  // They had none: the owner screen could not tell them apart except by their
  // wording, which is the thing most likely to change.
  const codes = codesIn('controls.js');
  assert.equal(codes.length, 3, `expected three health codes, found ${codes.join(', ')}`);
  for (const code of codes) assert.match(code, /^[A-Z_]+$/);
});

test('a route names either another page or a tab, never both', () => {
  for (const [code, to] of Object.entries(CHECK_DESTINATIONS)) {
    assert.ok(to.label, `${code} has no label`);
    assert.ok(Boolean(to.href) !== Boolean(to.tab),
      `${code} must have exactly one of href or tab`);
  }
});

test('a check that found nothing offers no route', () => {
  // The link is an invitation to go and do work. A passing check has none.
  assert.equal(destinationFor({ code: 'STALE_BACKORDERS', ok: true }), null);
  assert.ok(destinationFor({ code: 'STALE_BACKORDERS', ok: false }));
});

test('a check with no route is handled rather than crashing', () => {
  // Most integrity checks have no single screen that owns them.
  assert.equal(destinationFor({ code: 'BAG_LEDGER_MISMATCH', ok: false }), null);
  assert.equal(destinationFor({ code: 'SOMETHING_ADDED_LATER', ok: false }), null);
  assert.equal(destinationFor(undefined), null);
});
