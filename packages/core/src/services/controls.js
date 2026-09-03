/**
 * Operational controls.
 *
 * An owner can stop field activity on a project — during a cutover, a stock
 * count, or when something has gone wrong and the ledger needs to hold still.
 * The crew sees the reason rather than a failure.
 *
 * Replaces the parts of FMRv3 SystemControlService that still matter once
 * backups, health checks and recovery are the database's job.
 */

import { withTransaction } from '../db/pool.js';
import { LedgerError } from '../domain/ledger.js';
import { formatBagTagNumber } from '../domain/bagTag.js';

/** Current controls, defaulting to open. */
export async function getControls(client, projectId) {
  const { rows } = await client.query(
    `SELECT c.*, u.display_name AS locked_by_name
       FROM project_controls c
       LEFT JOIN users u ON u.id = c.locked_by
      WHERE c.project_id = $1`,
    [projectId]
  );

  const row = rows[0];
  if (!row) {
    return { fieldLocked: false, importLocked: false, reason: null, lockedBy: null, lockedAt: null };
  }

  return {
    fieldLocked: row.field_locked,
    importLocked: row.import_locked,
    reason: row.lock_reason,
    lockedBy: row.locked_by_name,
    lockedAt: row.locked_at
  };
}

/**
 * Refuse a field action while the project is locked.
 *
 * Called inside the action's own transaction, so a lock taken mid-action
 * cannot let it slip through.
 */
export async function assertFieldOpen(client, projectId) {
  const { rows } = await client.query(
    `SELECT field_locked, lock_reason FROM project_controls WHERE project_id = $1`,
    [projectId]
  );

  if (rows[0]?.field_locked) {
    throw new LedgerError(
      rows[0].lock_reason
        ? `Material movement is paused: ${rows[0].lock_reason}`
        : 'Material movement is paused on this project.',
      'PROJECT_LOCKED'
    );
  }
}

export async function assertImportOpen(client, projectId) {
  const { rows } = await client.query(
    `SELECT import_locked, lock_reason FROM project_controls WHERE project_id = $1`,
    [projectId]
  );

  if (rows[0]?.import_locked) {
    throw new LedgerError(
      rows[0].lock_reason
        ? `Importing is paused: ${rows[0].lock_reason}`
        : 'Importing is paused on this project.',
      'PROJECT_LOCKED'
    );
  }
}

/** Set the controls. A lock needs a reason — the crew will see it. */
export async function setControls(ctx, { fieldLocked, importLocked, reason }) {
  const { user, projectId } = ctx;

  if ((fieldLocked || importLocked) && !String(reason ?? '').trim()) {
    throw new LedgerError(
      'Pausing needs a reason — the crew is shown it.', 'MISSING_REASON'
    );
  }

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO project_controls
         (project_id, field_locked, import_locked, lock_reason, locked_by, locked_at)
       VALUES ($1,$2,$3,$4,$5, CASE WHEN $2 OR $3 THEN now() ELSE NULL END)
       ON CONFLICT (project_id) DO UPDATE SET
         field_locked = EXCLUDED.field_locked,
         import_locked = EXCLUDED.import_locked,
         lock_reason = EXCLUDED.lock_reason,
         locked_by = EXCLUDED.locked_by,
         locked_at = CASE WHEN EXCLUDED.field_locked OR EXCLUDED.import_locked
                          THEN coalesce(project_controls.locked_at, now())
                          ELSE NULL END,
         updated_at = now()
       RETURNING *`,
      [
        projectId, !!fieldLocked, !!importLocked,
        String(reason ?? '').trim() || null, user.id
      ]
    );

    // $1 is the project id twice over — once as a uuid column and once as the
    // text entity_id. Postgres cannot deduce one type for both, so each use is
    // cast. Without the ::uuid every pause and resume fails with 42P08.
    await client.query(
      `INSERT INTO audit_log
         (project_id, entity_type, entity_id, action, payload, user_id, user_email,
          source_interface)
       VALUES ($1::uuid,'PROJECT',$1::text,$2,$3,$4,$5,'OWNER')`,
      [
        projectId,
        fieldLocked || importLocked ? 'CONTROLS_LOCKED' : 'CONTROLS_UNLOCKED',
        { fieldLocked: !!fieldLocked, importLocked: !!importLocked, reason },
        user.id, user.email
      ]
    );

    return {
      fieldLocked: rows[0].field_locked,
      importLocked: rows[0].import_locked,
      reason: rows[0].lock_reason,
      lockedAt: rows[0].locked_at
    };
  });
}

/**
 * Take the next bag tag number for a project.
 *
 * FMRv3 did this (FieldService.gs:731) and the crew never typed a tag number.
 * Requiring one by hand is slow in gloves and invites the duplicate the
 * UNIQUE constraint then rejects — after the typing.
 *
 * Must be called inside the bagging transaction: the row lock is what stops
 * two crews bagging at the same moment from taking the same number. The
 * counter advances even if the surrounding transaction later rolls back,
 * which is the right trade — a gap in the numbering is harmless, a reused
 * number is not.
 *
 * The sequence restarts each calendar year, matching the BT-2025-00001 shape.
 */
export async function nextBagTagNumber(client, projectId) {
  const year = new Date().getFullYear();

  // Create the row if this project has never had its controls touched, so the
  // first bagging on a fresh project has a counter to advance.
  await client.query(
    `INSERT INTO project_controls (project_id) VALUES ($1)
     ON CONFLICT (project_id) DO NOTHING`,
    [projectId]
  );

  const { rows } = await client.query(
    `UPDATE project_controls
        SET tag_sequence = CASE
              WHEN tag_sequence_year IS DISTINCT FROM $2::integer THEN 2
              ELSE tag_sequence + 1
            END,
            tag_sequence_year = $2::integer
      WHERE project_id = $1
      RETURNING tag_prefix,
                CASE
                  WHEN tag_sequence_year IS DISTINCT FROM $2::integer THEN 1
                  ELSE tag_sequence - 1
                END AS allocated`,
    [projectId, year]
  );

  const row = rows[0];
  if (!row) throw new LedgerError('That project was not found.', 'NOT_FOUND');

  return formatBagTagNumber(row.tag_prefix, year, row.allocated);
}

/**
 * A health snapshot: what a database and a few counts can honestly say.
 *
 * FMRv3 kept its own health log because a spreadsheet cannot be monitored.
 * Postgres can, so this reports only what is specific to the workflow —
 * material sitting in a state it should not stay in.
 */
export async function getHealth(client, projectId) {
  const controls = await getControls(client, projectId);

  // One query, four independent aggregates.
  //
  // These were five queries handed to Promise.all on a single client, which
  // pg serialises internally and warns about — it is removed in pg@9, and
  // this file's own convention says a client runs one query at a time. As
  // subqueries they are one round trip instead of five and the rule holds.
  const { rows } = await client.query(
    `SELECT
       (SELECT count(*) FROM backorder_requests
         WHERE project_id = $1 AND active AND status = 'Pending'
           AND reported_at < now() - interval '7 days')      AS stale,
       (SELECT count(*) FROM field_notices
         WHERE project_id = $1 AND status = 'Active'
           AND raised_at < now() - interval '3 days')        AS unresolved,
       (SELECT count(*) FROM bag_tag_items i
          JOIN bag_tags t ON t.id = i.bag_tag_id
         WHERE t.project_id = $1 AND i.status = 'Active'
           AND t.bagged_at < now() - interval '30 days')     AS bags,
       (SELECT max(created_at) FROM material_transactions
         WHERE project_id = $1)                              AS last_activity`,
    [projectId]
  );

  const counts = rows[0];

  const checks = [
    {
      name: 'Backorders awaiting a decision',
      detail: 'Raised more than a week ago and still pending.',
      count: Number(counts.stale),
      ok: Number(counts.stale) === 0
    },
    {
      name: 'Notices the crew has not acted on',
      detail: 'Outstanding for more than three days.',
      count: Number(counts.unresolved),
      ok: Number(counts.unresolved) === 0
    },
    {
      name: 'Bags sitting unissued',
      detail: 'Material reserved over a month ago and still in the bag.',
      count: Number(counts.bags),
      ok: Number(counts.bags) === 0
    }
  ];

  return {
    controls,
    lastActivityAt: counts.last_activity,
    checks,
    ok: checks.every((c) => c.ok) && !controls.fieldLocked
  };
}
