/**
 * The sign-in ceiling.
 *
 * Sign-in acts before it knows who is calling, and verifying a token costs an
 * outbound request to Google, so an unauthenticated loop is an amplification
 * this server pays for. The limit has to bite — and it has to not bite a
 * shift change, where thirty people sign in at once from one site's network.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter, callerAddress } from '../../api/src/rateLimit.js';

const from = (address, socket = '10.0.0.1') => ({
  headers: address === null ? {} : { 'x-forwarded-for': address },
  socket: { remoteAddress: socket }
});

test('attempts up to the limit are allowed and the next one is not', () => {
  const limiter = createRateLimiter({ attempts: 3, windowMs: 60_000 });
  const caller = from('1.2.3.4');

  assert.deepEqual(
    [1, 2, 3, 4].map(() => limiter.exceeded(caller)),
    [false, false, false, true]
  );
});

test('the window moves, so a quiet spell restores the allowance', () => {
  let clock = 0;
  const limiter = createRateLimiter({ attempts: 2, windowMs: 1000 }, () => clock);
  const caller = from('1.2.3.4');

  assert.equal(limiter.exceeded(caller), false);
  assert.equal(limiter.exceeded(caller), false);
  assert.equal(limiter.exceeded(caller), true);

  clock += 1001;
  assert.equal(limiter.exceeded(caller), false, 'the earlier attempts have aged out');
});

test('one address being limited does not limit anybody else', () => {
  const limiter = createRateLimiter({ attempts: 1, windowMs: 60_000 });

  limiter.exceeded(from('1.1.1.1'));
  assert.equal(limiter.exceeded(from('1.1.1.1')), true);
  assert.equal(limiter.exceeded(from('2.2.2.2')), false, 'a different crew is unaffected');
});

test('a shift change is not mistaken for an attack', () => {
  // Thirty people signing in at once, each from their own device.
  const limiter = createRateLimiter();
  const blocked = Array.from({ length: 30 }, (_, i) =>
    limiter.exceeded(from(`10.1.0.${i}`))).filter(Boolean);

  assert.equal(blocked.length, 0);
});

test('the address is read from the end of x-forwarded-for, not the start', () => {
  // A caller can write anything into that header. The proxy appends the
  // address it actually saw, so only the last entry is worth counting —
  // reading the first would let one caller pose as a new one every request.
  assert.equal(callerAddress(from('203.0.113.9, 198.51.100.4')), '198.51.100.4');
});

test('a forged prefix does not buy a fresh allowance', () => {
  const limiter = createRateLimiter({ attempts: 1, windowMs: 60_000 });

  limiter.exceeded(from('spoofed-a, 198.51.100.4'));
  assert.equal(
    limiter.exceeded(from('spoofed-b, 198.51.100.4')), true,
    'the real address is still what counts'
  );
});

test('with no proxy header the socket address is counted', () => {
  assert.equal(callerAddress(from(null, '192.0.2.7')), '192.0.2.7');
});

test('a caller with neither is still counted, not skipped', () => {
  assert.equal(callerAddress({ headers: {}, socket: {} }), 'unknown');
});
