/**
 * A backorder from the crew's ask to the office's answer and back.
 *
 * The domain functions covering these rules are tested on their own and were
 * right throughout. What was wrong was the order the service called them in
 * and which request it attached a notice to — so these run the whole round
 * trip, the way it happens on site.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { enabled, connect, close, fixture, line } from './harness.js';

const skip = enabled ? false : 'set FMR_TEST_DATABASE_URL to run';

test('backorder lifecycle', { skip }, async (t) => {
  const { field, pool } = await connect();
  const { decideBackorder } = await import('../../src/services/backorderReview.js');
  const { inspectIntegrity } = await import('../../src/services/integrity.js');
  t.after(close);

  const notices = async () => (await pool.query(
    `SELECT kind, status, qty_outstanding FROM field_notices ORDER BY raised_at`))
      .rows.map((n) => ({ ...n, qty_outstanding: Number(n.qty_outstanding) }));
  const requests = async () => (await pool.query(
    `SELECT qty_requested, qty_pending, qty_confirmed, status, active
       FROM backorder_requests ORDER BY reported_at`)).rows;
  const onlyRequestId = async () => (await pool.query(
    'SELECT id FROM backorder_requests ORDER BY reported_at LIMIT 1')).rows[0].id;

  const raise = (f, quantity, over = {}) => field.performFieldAction(f.ctx, {
    action: 'BACKORDER_REQUESTED', lineId: f.lineId, quantity, reason: 'Not in stores', ...over
  });

  await t.test('answering a returned request revives it instead of being refused', async () => {
    const f = await fixture({ requested: 100 });
    await raise(f, 60);
    await decideBackorder(f.ctx, {
      requestId: await onlyRequestId(), decision: 'RETURN',
      quantity: 60, notes: 'which heat number?'
    });

    // The crew supplies the heat number by raising it again. This was refused
    // as a duplicate commitment — the commitment being the very request it
    // answered — so the notice could never be cleared by any quantity.
    const result = await raise(f, 60, { notes: 'heat 12345' });
    assert.equal(result.noticesSettled, 60);

    assert.deepEqual(await notices(), [
      { kind: 'RETURNED', status: 'Resolved', qty_outstanding: 0 }
    ]);

    const open = await requests();
    assert.equal(open.length, 1, 'the answer revives the request, never opens a second');
    assert.equal(open[0].status, 'Pending', 'the ball is back with the office');
  });

  await t.test('a resubmission larger than the return opens the difference', async () => {
    const f = await fixture({ requested: 100 });
    await raise(f, 60);
    await decideBackorder(f.ctx, {
      requestId: await onlyRequestId(), decision: 'RETURN', quantity: 60, notes: 'heat?'
    });

    await raise(f, 80, { notes: 'heat 12345, and 20 more short' });

    const open = await requests();
    assert.equal(open.length, 2);
    assert.equal(Number(open[0].qty_pending), 60, 'the returned request, answered');
    assert.equal(Number(open[1].qty_pending), 20, 'the genuinely new ask');
    assert.equal(Number((await line(f.lineId)).qty_pending_backorder), 80);
  });

  await t.test('a resubmission still cannot exceed what the line needs', async () => {
    const f = await fixture({ requested: 100 });
    await raise(f, 60);
    await decideBackorder(f.ctx, {
      requestId: await onlyRequestId(), decision: 'RETURN', quantity: 60, notes: 'heat?'
    });

    await assert.rejects(() => raise(f, 130, { notes: 'heat 12345' }),
      (error) => error.code === 'LIMIT_EXCEEDED');
    assert.equal(Number((await line(f.lineId)).qty_pending_backorder), 60,
      'the refusal must leave the line alone');
  });

  await t.test('a partial return puts its notice on the request that carries it', async () => {
    const f = await fixture({ requested: 100 });
    await raise(f, 60);
    const requestId = await onlyRequestId();
    await decideBackorder(f.ctx, { requestId, decision: 'CONFIRM', quantity: 20 });
    const returned = await decideBackorder(f.ctx, {
      requestId, decision: 'RETURN', quantity: 40, notes: 'which heat number?'
    });

    // The returned quantity moves to the split request, so that is what the
    // notice is about. Pointing it at the original left it attached to a
    // request holding none of it.
    const { rows } = await pool.query(
      `SELECT source_request_id = $1 AS on_split FROM field_notices WHERE kind = 'RETURNED'`,
      [returned.splitRequestId]);
    assert.equal(rows[0].on_split, true);
  });

  await t.test('locating material clears a confirmed notice but not a returned one', async () => {
    const f = await fixture({ requested: 100 });
    await raise(f, 60);
    const requestId = await onlyRequestId();
    await decideBackorder(f.ctx, { requestId, decision: 'CONFIRM', quantity: 20 });
    await decideBackorder(f.ctx, {
      requestId, decision: 'RETURN', quantity: 40, notes: 'which heat number?'
    });

    // 50 turns up, which settles the 20 the office had committed to and closes
    // that request.
    await field.performFieldAction(f.ctx, {
      action: 'CONFIRM_AVAILABLE', lineId: f.lineId, quantity: 50, storageLocation: 'RACK 12'
    });

    const after = await notices();
    const confirmed = after.find((n) => n.kind === 'CONFIRMED');
    const returned = after.find((n) => n.kind === 'RETURNED');

    assert.equal(confirmed.status, 'Superseded',
      'nothing is on order any more, so "stop looking" is not an instruction');
    assert.equal(returned.status, 'Active',
      'the office is still waiting on an answer, and the crew must still see the question');

    // And the crew can still give that answer.
    const answered = await field.performFieldAction(f.ctx, {
      action: 'BACKORDER_REQUESTED', lineId: f.lineId, quantity: 40,
      reason: 'Not in stores', notes: 'heat 12345'
    });
    assert.equal(answered.noticesSettled, 40);

    const client = await pool.connect();
    assert.equal((await inspectIntegrity(client, f.projectId)).ok, true);
    client.release();
  });

  await t.test('a rejected notice survives until the crew finds the material', async () => {
    const f = await fixture({ requested: 100 });
    await raise(f, 60);
    await decideBackorder(f.ctx, {
      requestId: await onlyRequestId(), decision: 'REJECT', quantity: 60,
      notes: 'obsolete, use the 316L equivalent'
    });

    // Rejecting deactivates the request and raises the notice in one go, so
    // "its request is not active" is true the instant the notice exists.
    // Sweeping on that took the instruction off the card before anyone acted.
    assert.deepEqual(await notices(), [
      { kind: 'REJECTED', status: 'Active', qty_outstanding: 60 }
    ]);

    await field.performFieldAction(f.ctx, {
      action: 'CONFIRM_AVAILABLE', lineId: f.lineId, quantity: 60, storageLocation: 'RACK 12'
    });
    assert.equal((await notices())[0].status, 'Resolved',
      'found it themselves, which is what the notice asked for');
  });
});
