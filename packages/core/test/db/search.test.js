/**
 * Search against a real database.
 *
 * What a crew is shown when their term matches more than the page will hold.
 * The rule is not that they see everything — it is that they are never shown
 * a capped list as though it were everything.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { enabled, connect, close, fixture } from './harness.js';

const skip = enabled ? false : 'set FMR_TEST_DATABASE_URL to run';

test('search', { skip }, async (t) => {
  const { pool } = await connect();
  const { searchLines } = await import('../../src/services/search.js');
  t.after(close);

  /** One FMR with `count` lines, all on the same drawing sheet. */
  async function withLines(count, { fmrNumber = 'FMR-500', sheet = '3' } = {}) {
    const f = await fixture({ requested: 10 });
    const fmrId = (await pool.query(
      `INSERT INTO fmr_headers (project_id,fmr_number,current_status)
       VALUES ($1,$2,'Open') RETURNING id`, [f.projectId, fmrNumber])).rows[0].id;

    for (let i = 1; i <= count; i += 1) {
      await pool.query(
        `INSERT INTO fmr_lines (project_id,fmr_id,line_number,material_description,uom,
                                qty_requested,storage_location,iso_number,iso_sheet,active)
         VALUES ($1,$2,$3,'2in PIPE SCH40','FT',10,'RACK 12','LP131-SC-824001',$4,true)`,
        [f.projectId, fmrId, i, sheet]);
    }
    return f;
  }

  await t.test('a complete result is not flagged as cut short', async () => {
    const f = await withLines(5);
    const found = await searchLines(pool, f.projectId, { query: 'FMR-500', mode: 'FMR' });
    assert.equal(found.results.length, 5);
    assert.equal(found.truncated, false);
  });

  await t.test('a result that exactly fills the limit is still complete', async () => {
    const f = await withLines(5);
    const found = await searchLines(pool, f.projectId,
      { query: 'FMR-500', mode: 'FMR', limit: 5 });
    assert.equal(found.results.length, 5);
    assert.equal(found.truncated, false, 'ending on the limit is not evidence of more');
  });

  await t.test('a result the limit cut is flagged, so the page can say so', async () => {
    const f = await withLines(12);
    const found = await searchLines(pool, f.projectId,
      { query: 'FMR-500', mode: 'FMR', limit: 5 });

    // Shown 5 of 12 with no sign of the rest, a crew reads it as the whole
    // answer and never goes looking for the material on the lines beneath.
    assert.equal(found.results.length, 5);
    assert.equal(found.truncated, true);
    assert.equal(found.limit, 5);
  });

  await t.test('a drawing is found by its single-digit sheet', async () => {
    const f = await withLines(4, { sheet: '3' });
    const found = await searchLines(f.pool ?? pool, f.projectId,
      { query: 'LP131-SC-824001-3', mode: 'ISO' });
    assert.equal(found.results.length, 4);
    assert.ok(found.results.every((line) => line.isoSheet === '3'));
  });

  await t.test('a search with nothing behind it reports nothing, not a cut list', async () => {
    const f = await withLines(3);
    const found = await searchLines(pool, f.projectId, { query: 'NOPE', mode: 'FMR' });
    assert.deepEqual(found.results, []);
    assert.equal(found.truncated, false);
  });
});
