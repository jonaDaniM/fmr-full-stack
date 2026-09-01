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

  const existing = await pool.query(
    'SELECT request_hash, response FROM idempotency_keys WHERE key = $1',
    [key]
  );

  if (existing.rows[0]) {
    // Same key, different payload: the client has a bug, or reused a key.
    // Refusing is safer than guessing which one they meant.
    if (existing.rows[0].request_hash !== requestHash) throw new IdempotencyConflict();
    return { ...existing.rows[0].response, replayed: true };
  }

  const response = await action();

  // If two retries race, the loser finds the row already there and replays it.
  const inserted = await pool.query(
    `INSERT INTO idempotency_keys (key, user_id, request_hash, response)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (key) DO NOTHING
     RETURNING key`,
    [key, user.id, requestHash, response]
  );

  if (!inserted.rows[0]) {
    const winner = await pool.query(
      'SELECT response FROM idempotency_keys WHERE key = $1',
      [key]
    );
    return { ...winner.rows[0].response, replayed: true };
  }

  return response;
}

/** Keys older than the retention window are no longer useful. */
export async function purgeExpired(olderThanHours = 48) {
  const { rowCount } = await pool.query(
    `DELETE FROM idempotency_keys WHERE created_at < now() - ($1 || ' hours')::interval`,
    [olderThanHours]
  );
  return rowCount;
}
