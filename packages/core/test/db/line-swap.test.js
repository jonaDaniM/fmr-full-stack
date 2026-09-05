/**
 * Line swap against a real database.
 *
 * The accounting is tested pure in swap.test.js. What only exists with a
 * database underneath: that the CHECK constraint survives a swap, that both
 * lines move in one transaction, and that the obligation can actually be
 * answered afterwards — who borrowed it, from whom, and how much is still owed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { enabled, connect, close, fixture, secondFmr, line } from './harness.js';

const skip = enabled ? false : 'set FMR_TEST_DATABASE_URL to run';

// One pool for the file. Registering close per test means the first test to
// finish ends the pool underneath the others.
test.after(async () => { if (enabled) await close(); });

/** A donor line holding real material, matched to the fixture's line. */
async function donorWith(pool, projectId, { available, requested = 100 }) {
  const { fmrId, lineId } = await secondFmr(projectId, { number: 'FMR-DONOR', requested });
  await pool.query(
    `UPDATE fmr_lines
        SET commodity_code='PF-A106', size='2', uom='FT',
            qty_confirmed_located=$2, qty_available=$2
      WHERE id=$1`, [lineId, available]);
  return { fmrId, lineId };
}

/** Make the fixture's line match the donor's material. */
async function matchReceiver(pool, lineId) {
  await pool.query(
    `UPDATE fmr_lines SET commodity_code='PF-A106', size='2', uom='FT' WHERE id=$1`,
    [lineId]);
}

test('borrowing moves material and leaves the donor visibly short', { skip }, async () => {
  const { pool, swaps } = await connect();

  const f = await fixture({ requested: 100 });
  await matchReceiver(pool, f.lineId);
  const donor = await donorWith(pool, f.projectId, { available: 60 });

  const { swap } = await swaps.borrowMaterial(f.ctx, {
    donorLineId: donor.lineId, receiverLineId: f.lineId,
    quantity: 25, reason: 'Weld crew waiting'
  });

  const after = await line(donor.lineId);
  assert.equal(Number(after.qty_available), 35);
  assert.equal(Number(after.qty_confirmed_located), 35);
  assert.equal(Number(after.qty_requested), 100, 'the donor still needs what it needed');
  assert.equal(Number(after.qty_not_yet_located), 65, 'the shortfall came back');

  const receiver = await line(f.lineId);
  assert.equal(Number(receiver.qty_issued), 25, 'the receiver got credit');
  assert.equal(Number(receiver.qty_available), 0, 'it went straight to the crew');

  assert.equal(Number(swap.qty_borrowed), 25);
  assert.equal(Number(swap.qty_outstanding), 25);
  assert.equal(swap.status, 'Open');
});

test('the located invariant survives a swap on both lines', { skip }, async () => {
  const { pool, swaps } = await connect();

  const f = await fixture({ requested: 100 });
  await matchReceiver(pool, f.lineId);
  const donor = await donorWith(pool, f.projectId, { available: 50 });

  await swaps.borrowMaterial(f.ctx, {
    donorLineId: donor.lineId, receiverLineId: f.lineId, quantity: 30
  });

  // The CHECK constraint would have refused the write, but assert it plainly:
  // this is the rule the whole ledger rests on.
  const { rows } = await pool.query(
    `SELECT qty_confirmed_located, qty_available, qty_active_bagged, qty_issued
       FROM fmr_lines WHERE id = ANY($1)`, [[donor.lineId, f.lineId]]);

  for (const r of rows) {
    assert.equal(
      Number(r.qty_confirmed_located),
      Number(r.qty_available) + Number(r.qty_active_bagged) + Number(r.qty_issued)
    );
  }
});

test('both sides of the movement are recorded under one correlation', { skip }, async () => {
  const { pool, swaps } = await connect();

  const f = await fixture({ requested: 100 });
  await matchReceiver(pool, f.lineId);
  const donor = await donorWith(pool, f.projectId, { available: 40 });

  const { swap } = await swaps.borrowMaterial(f.ctx, {
    donorLineId: donor.lineId, receiverLineId: f.lineId, quantity: 15
  });

  const { rows } = await pool.query(
    `SELECT transaction_type, quantity, fmr_line_id FROM material_transactions
      WHERE correlation_id = $1 ORDER BY transaction_type`, [swap.correlation_id]);

  assert.equal(rows.length, 2, 'a lend and a borrow');
  const lent = rows.find((r) => r.transaction_type === 'SWAP_LENT');
  const borrowed = rows.find((r) => r.transaction_type === 'SWAP_BORROWED');

  assert.equal(Number(lent.quantity), -15, 'material left the donor');
  assert.equal(Number(borrowed.quantity), 15, 'and reached the receiver');
  assert.equal(lent.fmr_line_id, donor.lineId);
  assert.equal(borrowed.fmr_line_id, f.lineId);
});

test('bagged material cannot be borrowed away from the crew holding it', { skip }, async () => {
  const { pool, swaps } = await connect();

  const f = await fixture({ requested: 100 });
  await matchReceiver(pool, f.lineId);
  const donor = await donorWith(pool, f.projectId, { available: 0 });
  await pool.query(
    `UPDATE fmr_lines SET qty_confirmed_located=40, qty_active_bagged=40, qty_available=0
      WHERE id=$1`, [donor.lineId]);

  await assert.rejects(
    swaps.borrowMaterial(f.ctx, {
      donorLineId: donor.lineId, receiverLineId: f.lineId, quantity: 10
    }),
    /nothing on the shelf to lend/
  );
});

test('material that does not match is refused', { skip }, async () => {
  const { pool, swaps } = await connect();

  const f = await fixture({ requested: 100 });
  await matchReceiver(pool, f.lineId);
  const donor = await donorWith(pool, f.projectId, { available: 50 });
  await pool.query(`UPDATE fmr_lines SET size='6' WHERE id=$1`, [donor.lineId]);

  await assert.rejects(
    swaps.borrowMaterial(f.ctx, {
      donorLineId: donor.lineId, receiverLineId: f.lineId, quantity: 10
    }),
    /different size/
  );
});

test('a repayment settles the debt without crediting the shelf', { skip }, async () => {
  const { pool, swaps } = await connect();

  const f = await fixture({ requested: 100 });
  await matchReceiver(pool, f.lineId);
  const donor = await donorWith(pool, f.projectId, { available: 60 });

  const { swap } = await swaps.borrowMaterial(f.ctx, {
    donorLineId: donor.lineId, receiverLineId: f.lineId, quantity: 40
  });

  const before = await line(donor.lineId);
  const partial = await swaps.repaySwap(f.ctx, { swapId: swap.id, quantity: 15 });

  assert.equal(Number(partial.qty_outstanding), 25);
  assert.equal(partial.status, 'Partially Repaid');

  const after = await line(donor.lineId);
  assert.equal(
    Number(after.qty_available), Number(before.qty_available),
    'settling a debt is not the same as material arriving on the shelf'
  );

  const settled = await swaps.repaySwap(f.ctx, { swapId: swap.id, quantity: 25 });
  assert.equal(settled.status, 'Repaid');
  assert.equal(Number(settled.qty_outstanding), 0);
});

test('the open queue shows what is still owed, with its age', { skip }, async () => {
  const { pool, swaps } = await connect();

  const f = await fixture({ requested: 100 });
  await matchReceiver(pool, f.lineId);
  const donor = await donorWith(pool, f.projectId, { available: 60 });

  const { swap } = await swaps.borrowMaterial(f.ctx, {
    donorLineId: donor.lineId, receiverLineId: f.lineId, quantity: 20
  });

  const client = await pool.connect();
  try {
    let open = await swaps.openSwaps(client, f.ctx);
    assert.equal(open.length, 1);
    assert.equal(open[0].donor_fmr_number, 'FMR-DONOR');
    assert.equal(open[0].receiver_fmr_number, 'FMR-001');
    assert.equal(Number(open[0].qty_outstanding), 20);
    assert.equal(open[0].age_days, 0);

    await swaps.repaySwap(f.ctx, { swapId: swap.id, quantity: 20 });

    open = await swaps.openSwaps(client, f.ctx);
    assert.equal(open.length, 0, 'a repaid swap leaves the queue');

    const all = await swaps.openSwaps(client, f.ctx, { includeSettled: true });
    assert.equal(all.length, 1, 'but it is still on the record');
  } finally {
    client.release();
  }
});

test('candidate donors are found by matching material', { skip }, async () => {
  const { pool, swaps } = await connect();

  const f = await fixture({ requested: 100 });
  await matchReceiver(pool, f.lineId);
  const donor = await donorWith(pool, f.projectId, { available: 45 });

  // A line with the right code but the wrong size must not be offered.
  const wrong = await secondFmr(f.projectId, { number: 'FMR-WRONG', requested: 20 });
  await pool.query(
    `UPDATE fmr_lines SET commodity_code='PF-A106', size='6', uom='FT',
            qty_confirmed_located=20, qty_available=20 WHERE id=$1`, [wrong.lineId]);

  const client = await pool.connect();
  try {
    const { donors } = await swaps.findDonors(client, f.ctx, { lineId: f.lineId });
    assert.equal(donors.length, 1, 'only the matching line');
    assert.equal(donors[0].lineId, donor.lineId);
    assert.equal(donors[0].lendable, 45);
  } finally {
    client.release();
  }
});

test('a line with no commodity code offers no donors at all', { skip }, async () => {
  const { pool, swaps } = await connect();

  const f = await fixture({ requested: 100 });
  await donorWith(pool, f.projectId, { available: 30 });

  const client = await pool.connect();
  try {
    const result = await swaps.findDonors(client, f.ctx, { lineId: f.lineId });
    assert.equal(result.donors.length, 0);
    assert.equal(result.reason, 'NO_COMMODITY_CODE');
  } finally {
    client.release();
  }
});

test('a swap survives being read back as history on both lines', { skip }, async () => {
  const { pool, swaps } = await connect();

  const f = await fixture({ requested: 100 });
  await matchReceiver(pool, f.lineId);
  const donor = await donorWith(pool, f.projectId, { available: 60 });

  await swaps.borrowMaterial(f.ctx, {
    donorLineId: donor.lineId, receiverLineId: f.lineId, quantity: 12
  });

  const client = await pool.connect();
  try {
    const fromDonor = await swaps.swapsForLine(client, f.ctx, donor.lineId);
    const fromReceiver = await swaps.swapsForLine(client, f.ctx, f.lineId);
    assert.equal(fromDonor.length, 1);
    assert.equal(fromReceiver.length, 1);
    assert.equal(fromDonor[0].id, fromReceiver[0].id, 'the same obligation, both ways');
  } finally {
    client.release();
  }
});
