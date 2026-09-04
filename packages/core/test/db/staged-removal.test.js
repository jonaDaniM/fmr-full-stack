/**
 * Removing staged material before publishing, against a real database.
 *
 * Its own file so it gets its own pool: the harness builds one schema per test
 * file and closes the pool when that file's suite ends.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { enabled, connect, close, fixture } from './harness.js';

const skip = enabled ? false : 'set FMR_TEST_DATABASE_URL to run';

/**
 * Removing staged material before it is published.
 *
 * One drawing legitimately yields several FMRs over months: crews install the
 * pipe and field welds, then come back for valves, bolts and gaskets. The
 * office publishes the part being worked now, which means taking the rest out
 * of the batch rather than publishing material nobody is going to look for.
 */
test('staged removal', { skip }, async (t) => {
  const { drafts, pool } = await connect();
  t.after(close);

  const staging = await import('../../../import/src/staging.js');

  const stage = async (ctx, lines) => {
    const created = await drafts.createDraft(ctx, {
      header: { fmrNumber: 'FMR-600', isoNumber: 'D-4410', isoSheet: '01' },
      lines
    });
    const { rows } = await pool.query(
      'SELECT id, line_number FROM import_lines WHERE item_id = $1 ORDER BY line_number',
      [created.itemId]
    );
    return { ...created, lineIds: rows.map((r) => r.id) };
  };

  const threeLines = [
    { description: 'PIPE, CS A106 GR B', quantity: '120', uom: 'FT' },
    { description: 'GATE VALVE 6in 150#', quantity: '2', uom: 'EA' },
    { description: 'GASKET 6in 150# RF', quantity: '4', uom: 'EA' }
  ];

  await t.test('a line the office is not working yet comes out', async () => {
    const f = await fixture();
    const item = await stage(f.ctx, threeLines);

    await staging.removeStagedLine(f.ctx, { lineId: item.lineIds[1] });

    const { rows } = await pool.query(
      'SELECT description, line_number FROM import_lines WHERE item_id = $1 ORDER BY line_number',
      [item.itemId]
    );
    assert.equal(rows.length, 2);
    assert.match(rows[0].description, /PIPE/);
    assert.match(rows[1].description, /GASKET/);

    // Numbering is what the office reads back to the field, so no gaps.
    assert.deepEqual(rows.map((r) => r.line_number), [1, 2]);
  });

  await t.test('the count the publish button reads is kept in step', async () => {
    const f = await fixture();
    const item = await stage(f.ctx, threeLines);
    await staging.removeStagedLine(f.ctx, { lineId: item.lineIds[0] });

    const { rows } = await pool.query(
      'SELECT line_count FROM import_items WHERE id = $1', [item.itemId]
    );
    assert.equal(rows[0].line_count, 2, 'a stale count would mis-state the batch');
  });

  await t.test('the last line cannot be removed, because an empty FMR is not findable',
    async () => {
      const f = await fixture();
      const item = await stage(f.ctx, [threeLines[0]]);

      const failure = await staging.removeStagedLine(f.ctx, { lineId: item.lineIds[0] })
        .then(() => null, (error) => error);

      assert.ok(failure, 'an FMR with no material was allowed');
      assert.equal(failure.code, 'LAST_LINE');
      assert.match(failure.message, /whole FMR/i, 'and it says what to do instead');
    });

  await t.test('a whole proposed FMR comes out, and takes its lines with it', async () => {
    const f = await fixture();
    const item = await stage(f.ctx, threeLines);

    const gone = await staging.removeStagedItem(f.ctx, { itemId: item.itemId });
    assert.equal(gone.fmrNumber, 'FMR-600');

    const items = await pool.query('SELECT id FROM import_items WHERE id = $1', [item.itemId]);
    assert.equal(items.rows.length, 0);

    const lines = await pool.query(
      'SELECT id FROM import_lines WHERE item_id = $1', [item.itemId]
    );
    assert.equal(lines.rows.length, 0, 'the lines outlived the FMR they belonged to');
  });

  await t.test('removing is recorded, because material stopped being requisitioned',
    async () => {
      const f = await fixture();
      const item = await stage(f.ctx, threeLines);
      await staging.removeStagedLine(f.ctx, { lineId: item.lineIds[2] });
      await staging.removeStagedItem(f.ctx, { itemId: item.itemId });

      const { rows } = await pool.query(
        `SELECT action FROM audit_log
          WHERE action IN ('STAGED_LINE_REMOVED','STAGED_FMR_REMOVED')
          ORDER BY created_at`
      );
      assert.deepEqual(rows.map((r) => r.action),
        ['STAGED_LINE_REMOVED', 'STAGED_FMR_REMOVED']);
    });

  await t.test('a published FMR is not removable from the queue', async () => {
    const f = await fixture();
    const item = await stage(f.ctx, threeLines);
    await pool.query('UPDATE import_batches SET published_at = now() WHERE id = $1',
      [item.batchId]);

    const failure = await staging.removeStagedItem(f.ctx, { itemId: item.itemId })
      .then(() => null, (error) => error);

    assert.ok(failure, 'a published FMR was removed from the import queue');
    assert.equal(failure.code, 'NOT_FOUND');
  });
});
