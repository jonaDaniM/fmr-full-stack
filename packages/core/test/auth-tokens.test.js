/**
 * What a Google sign-in token has to say before anyone is let in.
 *
 * The tokeninfo endpoint checks the signature and expiry before it answers,
 * so for a long time this code checked only `aud`. That was enough in
 * practice and wrong as a habit: the claims this system's own decisions rest
 * on should be checked where those decisions are made, not left to a comment
 * about somebody else's service.
 *
 * The endpoint is stubbed here. What is under test is the judgement applied to
 * what it returns.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyGoogleToken, AuthError } from '../../api/src/auth.js';

const CLIENT_ID = 'test-client.apps.googleusercontent.com';

const valid = () => ({
  aud: CLIENT_ID,
  iss: 'https://accounts.google.com',
  exp: String(Math.floor(Date.now() / 1000) + 3600),
  email: 'Crew@Example.com',
  email_verified: 'true',
  name: 'A Crew Member'
});

/** Answer the next tokeninfo call with these claims, then put fetch back. */
async function withClaims(claims, fn, { ok = true } = {}) {
  const realFetch = globalThis.fetch;
  const realClientId = process.env.GOOGLE_CLIENT_ID;
  process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
  globalThis.fetch = async () => ({ ok, json: async () => claims });
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
    if (realClientId === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = realClientId;
  }
}

const refuses = (claims, expected, options) => async () => {
  await assert.rejects(
    () => withClaims(claims, () => verifyGoogleToken('token'), options),
    (error) => {
      assert.ok(error instanceof AuthError);
      assert.match(error.message, expected);
      return true;
    }
  );
};

test('a good token yields a normalised email and a name', async () => {
  const claims = await withClaims(valid(), () => verifyGoogleToken('token'));
  assert.equal(claims.email, 'crew@example.com');
  assert.equal(claims.name, 'A Crew Member');
});

test('a token for another application is refused',
  refuses({ ...valid(), aud: 'someone-else.apps.googleusercontent.com' },
    /different application/));

test('a token from an issuer that is not Google is refused',
  refuses({ ...valid(), iss: 'https://accounts.evil.example' }, /did not come from Google/));

test('the bare accounts.google.com issuer is accepted', async () => {
  const claims = await withClaims(
    { ...valid(), iss: 'accounts.google.com' }, () => verifyGoogleToken('token'));
  assert.equal(claims.email, 'crew@example.com');
});

test('an expired token is refused even if the endpoint returned it',
  refuses({ ...valid(), exp: String(Math.floor(Date.now() / 1000) - 60) }, /expired/));

test('an unverified email address is refused',
  refuses({ ...valid(), email_verified: 'false' }, /no verified email/));

test('a token carrying no email address is refused',
  refuses({ ...valid(), email: undefined }, /no email address/));

test('sign-in is refused outright when the server has no client id', async () => {
  const realFetch = globalThis.fetch;
  const real = process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_ID;
  // Nothing should reach the network: with no id to compare against, there is
  // no token that could be checked, so every one would otherwise be accepted.
  globalThis.fetch = async () => assert.fail('tokeninfo should not be called');
  try {
    await assert.rejects(() => verifyGoogleToken('token'), /not configured/);
  } finally {
    globalThis.fetch = realFetch;
    if (real !== undefined) process.env.GOOGLE_CLIENT_ID = real;
  }
});

test('a rejected token is not read for claims',
  refuses(valid(), /could not be verified/, { ok: false }));
