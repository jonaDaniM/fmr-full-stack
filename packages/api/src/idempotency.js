/**
 * Idempotency.
 *
 * Field crews work on poor connections. A request that times out mid-flight
 * gets retried — by the app, or by someone tapping the button again — and
 * without this, that retry issues the material a second time.
 *
 * The client sends a key it generated for the attempt. The first request with
 * that key does the work and its response is stored; any repeat returns the
 * stored response instead of acting again.
 */

import { createHash } from 'node:crypto';
import { pool } from '../../core/src/db/pool.js';

export class IdempotencyConflict extends Error {
  constructor() {
    super('This request id was already used with different details.');
    this.name = 'IdempotencyConflict';
    this.status = 409;
  }
}

/**
 * The first attempt with this key has not finished yet.
 *
 * 409 rather than an error page: the app retried, or somebody tapped twice,
 * and the honest answer is that the first one is still running. Written for
 * whoever is holding the phone.
 */
export class IdempotencyInFlight extends Error {
  constructor() {
    super('That is still going through. Give it a moment before trying again.');
    this.name = 'IdempotencyInFlight';
    this.status = 409;
  }
}

const hashOf = (body) =>
  createHash('sha256').update(JSON.stringify(body ?? {})).digest('hex');

/**
 * Run an action at most once per key.
 *
 * @param {string|undefined} key   client-supplied, from the Idempotency-Key header
 * @param {object} user
 * @param {object} body            the request, hashed to catch key reuse
 * @param {Function} action        does the work, returns the response
 */
export async function once(key, user, body, action) {
  if (!key) return action();

  const requestHash = hashOf(body);

  // Claim the key before doing the work, not after.
  //
  // Claiming afterwards left a window: two retries arriving together both
  // found no row, and both acted. The insert then deduplicated the response
  // while the material had already moved twice. The ledger's own row lock
  // happened to serialise them, so the invariant held — but that is the
  // ledger saving this, not this being correct.
  const claim = await pool.query(
    `INSERT INTO idempotency_keys (key, user_id, request_hash, response)
     VALUES ($1,$2,$3,NULL)
     ON CONFLICT (user_id, key) DO NOTHING
     RETURNING key`,
    [key, user.id, requestHash]
  );

  if (!claim.rows[0]) {
    // Somebody already holds this key. Either it is a genuine retry, or a
    // request still in flight.
    const existing = await pool.query(
      'SELECT request_hash, response FROM idempotency_keys WHERE user_id = $1 AND key = $2',
      [user.id, key]
    );

    const held = existing.rows[0];

    // The holder released the key between the conflict and this read, which
    // means their action failed. Retrying is exactly what should happen next,
    // and the caller is the one who can decide to.
    if (!held) throw new IdempotencyInFlight();

    // Same key, different payload: the client has a bug, or reused a key.
    // Refusing is safer than guessing which one they meant.
    if (held.request_hash !== requestHash) throw new IdempotencyConflict();

    // A claim with no response yet is the first attempt still running. Its
    // answer is not knowable from here, and returning an empty one would look
    // like success.
    if (held.response === null) throw new IdempotencyInFlight();

    return { ...held.response, replayed: true };
  }

  let response;
  try {
    response = await action();
  } catch (error) {
    // The work failed, so the key was never spent. Releasing it lets the crew
    // try the same action again instead of being told it already happened.
    await pool.query('DELETE FROM idempotency_keys WHERE user_id = $1 AND key = $2',
      [user.id, key]).catch(() => {});
    throw error;
  }

  await pool.query(
    'UPDATE idempotency_keys SET response = $3 WHERE user_id = $1 AND key = $2',
    [user.id, key, response]
  );

  return response;
}

/**
 * Keys older than the retention window are no longer useful.
 *
 * A claim with no response is skipped only while it could still be in flight;
 * past the window it is a request that died mid-action, and holding its key
 * forever would refuse a retry that should be allowed.
 */
export async function purgeExpired(olderThanHours = 48) {
  const { rowCount } = await pool.query(
    `DELETE FROM idempotency_keys WHERE created_at < now() - ($1 || ' hours')::interval`,
    [olderThanHours]
  );
  return rowCount;
}
