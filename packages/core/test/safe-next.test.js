/**
 * Sign-in must not be usable as a redirector to somebody else's site.
 *
 * An expired session sends you to `/signin.html?next=<where you were>`, and
 * after signing in the page assigns that to `location.href`. The parameter
 * comes from the URL bar, so the value is entirely attacker-controlled.
 *
 * The original test was `raw.startsWith('/')`. Two shapes pass it and still
 * leave the origin: `//evil.example.com/x` is a protocol-relative URL, and
 * browsers read `/\evil.example.com` as the same thing. A third gets there by
 * normalisation — `/..//evil.com` resolves to the *path* `//evil.com`, which
 * is protocol-relative again the moment it is assigned.
 *
 * On a sign-in page this matters more than it would anywhere else: the link
 * carries the real domain, the sign-in it shows is genuine, and only the page
 * afterwards is the attacker's. It is the shape of a phishing link that
 * survives being checked by someone careful.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { safeNext } from '../../web/public/lib/safeNext.js';

const ORIGIN = 'https://fmr-403972463929.us-central1.run.app';

/** Where the browser would actually end up, given what safeNext returned. */
const lands = (raw) => new URL(safeNext(raw, ORIGIN), ORIGIN).href;
const onSite = (raw) => lands(raw).startsWith(`${ORIGIN}/`);

test('a crafted next never leaves the origin', () => {
  const attacks = [
    '//evil.example.com/x',            // protocol-relative
    '/\\evil.example.com',             // backslash, read as protocol-relative
    '/\\/evil.example.com',
    '////evil.com',
    '/..//evil.com',                   // normalises to a protocol-relative path
    'https://evil.example.com',
    'http://evil.example.com',
    '//evil.example.com',
    'https:evil.example.com',
    `${ORIGIN}.evil.com/x`             // prefix that only looks like us
  ];

  for (const raw of attacks) {
    assert.ok(onSite(raw), `${raw} escaped to ${lands(raw)}`);
  }
});

test('a javascript or data url is refused', () => {
  for (const raw of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'vbscript:x']) {
    assert.equal(safeNext(raw, ORIGIN), '/home.html', `${raw} was not refused`);
  }
});

test('the returned path never starts with two slashes', () => {
  // The whole class of bug in one property: one leading slash, always.
  for (const raw of ['//x', '////x', '/..//x', '/./../..//x', '/\\x']) {
    assert.equal(/^\/\//.test(safeNext(raw, ORIGIN)), false,
      `${raw} produced a protocol-relative path`);
  }
});

test('a real deep link still survives an expired session', () => {
  // What shell.js actually writes: location.pathname, sometimes with a query.
  assert.equal(safeNext('/owner.html', ORIGIN), '/owner.html');
  assert.equal(safeNext('/admin.html', ORIGIN), '/admin.html');
  assert.equal(safeNext('/', ORIGIN), '/');
  assert.equal(safeNext('/drafts.html?tab=queue', ORIGIN), '/drafts.html?tab=queue');
  assert.equal(safeNext('/import.html#lines', ORIGIN), '/import.html#lines');
});

test('an absolute url back to this same origin is kept', () => {
  assert.equal(safeNext(`${ORIGIN}/owner.html`, ORIGIN), '/owner.html');
});

test('nothing, or nonsense, lands on home', () => {
  for (const raw of [null, undefined, '', '   ']) {
    assert.equal(safeNext(raw, ORIGIN).startsWith('/'), true);
    assert.equal(/^\/\//.test(safeNext(raw, ORIGIN)), false);
  }
  assert.equal(safeNext(null, ORIGIN), '/home.html');
});
