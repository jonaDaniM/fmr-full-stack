/**
 * Bag tags against a real database.
 *
 * A bag is a second record of material the line already counts, and these are
 * the cases where the two records could disagree. Every one of them was a bug.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  enabled, connect, close, fixture, secondFmr, line, bagItems, firstTagId
} from './harness.js';

const skip = enabled ? false : 'set FMR_TEST_DATABASE_URL to run';

test('bag tags', { skip }, async (t) => {
  const { field, corrections, integrity, pool } = await connect();
  t.after(close);

  await t.test('bagging twice into one tag keeps a single row the crew can empty', async () => {
    const f = await fixture({ requested: 100 });
    const bag = {
      action: 'BAG', lineId: f.lineId, bagTagNumber: 'BAG-9001', storageLocation: 'RACK 12'
    };
    await field.performFieldAction(f.ctx, { ...bag, quantity: 30 });
    await field.performFieldAction(f.ctx, { ...bag, quantity: 20 });

    const items = await bagItems();
    assert.equal(items.length, 1, 'two rows would split the bag against itself');
    assert.equal(Number(items[0].qty_bagged), 50);

    // The whole 50 is physically in that bag, so the whole 50 must come out.
    const result = await field.performFieldAction(f.ctx, {
      action: 'ISSUE_FROM_BAG', lineId: f.lineId, quantity: 50,
      bagTagId: await firstTagId(), issuedToName: 'Welder A'
    });
    assert.equal(result.line.quantities.issued, 50);
  });

  await t.test('a tag number already used on another FMR is refused', async () => {
    const f = await fixture({ requested: 100 });
    const other = await secondFmr(f.projectId);

    await field.performFieldAction(f.ctx, {
      action: 'BAG', lineId: f.lineId, quantity: 10,
      bagTagNumber: 'BAG-7000', storageLocation: 'RACK 12'
    });

    await assert.rejects(
      () => field.performFieldAction(f.ctx, {
        action: 'BAG', lineId: other.lineId, quantity: 5,
        bagTagNumber: 'BAG-7000', storageLocation: 'RACK 3'
      }),
      // The office reads the FMR number and location off the tag, so adopting
      // it would have shown the flanges as FMR-001's, at the wrong rack.
      (error) => error.code === 'BAG_TAG_IN_USE'
        && /already in use on FMR-001/.test(error.message)
    );

    const untouched = await line(other.lineId);
    assert.equal(Number(untouched.qty_active_bagged), 0, 'the refusal must write nothing');
  });

  await t.test('several lines of one FMR still share a tag', async () => {
    const f = await fixture({ requested: 100 });
    const second = (await pool.query(
      `INSERT INTO fmr_lines (project_id,fmr_id,line_number,material_description,uom,
                              qty_requested,storage_location,iso_number,iso_sheet,active)
       VALUES ($1,$2,2,'2in ELBOW','EA',20,'RACK 12','D-1234','05',true) RETURNING id`,
      [f.projectId, f.fmrId])).rows[0].id;

    const bag = { action: 'BAG', bagTagNumber: 'BAG-7000', storageLocation: 'RACK 12' };
    await field.performFieldAction(f.ctx, { ...bag, lineId: f.lineId, quantity: 10 });
    await field.performFieldAction(f.ctx, { ...bag, lineId: second, quantity: 6 });

    assert.equal((await bagItems()).length, 2, 'one row per line, one tag');
  });

  await t.test('correcting a bagging takes the material back out of the bag', async () => {
    const f = await fixture({ requested: 100 });
    const bagged = await field.performFieldAction(f.ctx, {
      action: 'BAG', lineId: f.lineId, quantity: 40, storageLocation: 'RACK 12'
    });

    await corrections.applyCorrection(f.ctx, {
      correlationId: bagged.correlationId, reason: 'keyed 40, meant 4'
    });

    // Left behind, this is a bag on the office's queue holding steel that is
    // not there, and someone is sent to fetch it.
    assert.equal((await bagItems()).length, 0);
    assert.equal(
      (await pool.query('SELECT status FROM bag_tags')).rows[0].status, 'Closed');

    const client = await pool.connect();
    assert.equal((await integrity.inspectIntegrity(client, f.projectId)).ok, true);
    client.release();
  });

  await t.test('correcting an issue puts the material back in the bag', async () => {
    const f = await fixture({ requested: 100 });
    await field.performFieldAction(f.ctx, {
      action: 'BAG', lineId: f.lineId, quantity: 40, storageLocation: 'RACK 12'
    });
    const tagId = await firstTagId();
    const issued = await field.performFieldAction(f.ctx, {
      action: 'ISSUE_FROM_BAG', lineId: f.lineId, quantity: 25,
      bagTagId: tagId, issuedToName: 'Welder A'
    });

    await corrections.applyCorrection(f.ctx, {
      correlationId: issued.correlationId, reason: 'issued to the wrong crew'
    });

    const [item] = await bagItems();
    assert.equal(Number(item.qty_remaining_in_bag), 40, 'the issue never happened');

    // The line says 40 is bagged. If the bag disagrees, that 25 can be issued
    // from neither the bag nor the shelf — it is stranded.
    const reissued = await field.performFieldAction(f.ctx, {
      action: 'ISSUE_FROM_BAG', lineId: f.lineId, quantity: 25,
      bagTagId: tagId, issuedToName: 'Welder B'
    });
    assert.equal(reissued.line.quantities.issued, 25);
  });

  await t.test('a bagging that has been partly issued cannot be corrected out', async () => {
    const f = await fixture({ requested: 100 });
    const bagged = await field.performFieldAction(f.ctx, {
      action: 'BAG', lineId: f.lineId, quantity: 40, storageLocation: 'RACK 12'
    });
    await field.performFieldAction(f.ctx, {
      action: 'ISSUE_FROM_BAG', lineId: f.lineId, quantity: 25,
      bagTagId: await firstTagId(), issuedToName: 'Welder A'
    });

    await assert.rejects(() => corrections.applyCorrection(f.ctx, {
      correlationId: bagged.correlationId, reason: 'wrong bag'
    }));

    const [item] = await bagItems();
    assert.equal(Number(item.qty_bagged), 40, 'the refusal must leave the bag alone');
    assert.equal(Number((await line(f.lineId)).qty_issued), 25);
  });
});
