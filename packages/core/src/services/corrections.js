/**
 * Owner corrections, persisted.
 *
 * Two steps on purpose: preview, then apply. An owner sees exactly what a
 * correction would do to the line before anything is written, because this is
 * the one operation that moves quantities without a physical event behind it.
 */

import { randomUUID } from 'node:crypto';
import { withTransaction } from '../db/pool.js';
import { LedgerError, lineState, lineStatus } from '../domain/ledger.js';
import { planCorrection } from '../domain/corrections.js';
import { serializeLine, HEADER_ROLLUP_SQL } from './field.js';
import { sweepStaleNotices } from './notices.js';

/**
 * Everything done to a line, grouped by the action that caused it.
 *
 * One field action can write several transactions — bagging material that had
 * to be located first writes both — so corrections work on the whole group,
 * never half of it.
 */
export async function getCorrectableHistory(client, projectId, lineId) {
  const { rows } = await client.query(
    `SELECT t.*, u.display_name AS user_name,
            c.id AS correction_id, c.reason AS correction_reason,
            c.applied_at AS corrected_at, c.applied_by_name AS corrected_by
       FROM material_transactions t
       LEFT JOIN users u ON u.id = t.performed_by
       LEFT JOIN corrections c
              ON c.reversed_correlation_id = t.correlation_id
             AND c.status = 'Applied'
      WHERE t.project_id = $1 AND t.fmr_line_id = $2
      ORDER BY t.created_at DESC`,
    [projectId, lineId]
  );

  const groups = new Map();

  for (const row of rows) {
    const key = row.correlation_id;
    if (!groups.has(key)) {
      groups.set(key, {
        correlationId: key,
        at: row.created_at,
        performedBy: row.performed_by_name ?? row.user_name,
        corrected: !!row.correction_id,
        correctionReason: row.correction_reason,
        correctedAt: row.corrected_at,
        correctedBy: row.corrected_by,
        transactions: []
      });
    }

    groups.get(key).transactions.push({
      id: String(row.id),
      type: row.transaction_type,
      quantity: Number(row.quantity),
      uom: row.uom,
      issuedTo: row.issued_to_name,
      storageLocation: row.storage_location,
      notes: row.notes
    });
  }

  return [...groups.values()];
}

/**
 * Undo a correction's effect on the bag it touched.
 *
 * The ledger's `bagged` total and the bag's own `qty_bagged` are two records of
 * the same steel, and a correction has to move both. Reversing only the line
 * left the bag saying it still held material the line had given up — a phantom
 * bag sitting on the office's active-bag queue — or, correcting an issue, left
 * the material locked: the line counted it as bagged while the bag would not
 * release it, and it could be issued from neither.
 *
 * The two directions, as FMRv3 wrote them (OwnerCorrectionService.gs:1384):
 *
 *   BAG              the reservation never happened — take it out of the bag.
 *   ISSUE_FROM_BAG   the issue never happened — put it back in.
 *
 * Correcting a BAG that has already been partly issued would take the bag below
 * what left it, so that is refused rather than forced: the issue is the later
 * event and has to be corrected first.
 */
async function reverseBagEffect(client, lineId, inverse) {
  const type = String(inverse.transaction_type).replace(/^CORRECTION_/, '');
  const bagTagId = type === 'BAG' ? inverse.targetBagTagId : inverse.sourceBagTagId;
  if (!bagTagId || (type !== 'BAG' && type !== 'ISSUE_FROM_BAG')) return;

  // The quantity on an inverse is negative; the movement is its magnitude.
  const quantity = Math.abs(Number(inverse.quantity));

  const { rows } = await client.query(
    `SELECT * FROM bag_tag_items
      WHERE bag_tag_id = $1 AND fmr_line_id = $2
      ORDER BY created_at
      FOR UPDATE`,
    [bagTagId, lineId]
  );
  const item = rows[0];
  if (!item) return;

  if (type === 'BAG') {
    const bagged = Number(item.qty_bagged) - quantity;
    const issuedFrom = Number(item.qty_issued_from_bag);

    if (bagged < issuedFrom - 1e-6) {
      throw new LedgerError(
        `${quantity} cannot be taken back out of bag ${item.bag_tag_id}: ` +
        `${issuedFrom} has already been issued from it. Correct the issue first.`,
        'BAG_ALREADY_ISSUED'
      );
    }

    if (bagged <= 1e-6) {
      await client.query(
        `DELETE FROM bag_tag_items WHERE id = $1`, [item.id]
      );
    } else {
      await client.query(
        `UPDATE bag_tag_items SET qty_bagged = $2, updated_at = now() WHERE id = $1`,
        [item.id, bagged]
      );
    }
  }

  if (type === 'ISSUE_FROM_BAG') {
    const issuedFrom = Math.max(0, Number(item.qty_issued_from_bag) - quantity);
    await client.query(
      `UPDATE bag_tag_items
          SET qty_issued_from_bag = $2, status = 'Active', updated_at = now()
        WHERE id = $1`,
      [item.id, issuedFrom]
    );
  }

  // The tag closes when nothing active is left under it, and reopens when
  // something is put back.
  await client.query(
    `UPDATE bag_tags t
        SET status = CASE WHEN EXISTS (
                       SELECT 1 FROM bag_tag_items i
                        WHERE i.bag_tag_id = t.id AND i.status = 'Active'
                          AND i.qty_remaining_in_bag > 0
                     ) THEN 'Active' ELSE 'Closed' END,
            updated_at = now()
      WHERE t.id = $1`,
    [bagTagId]
  );
}

/** Load the transactions of one action group, for previewing or applying. */
async function loadGroup(client, projectId, correlationId) {
  const { rows } = await client.query(
    `SELECT * FROM material_transactions
      WHERE project_id = $1 AND correlation_id = $2
        AND transaction_type NOT LIKE 'CORRECTION_%'
      ORDER BY created_at`,
    [projectId, correlationId]
  );

  if (!rows.length) {
    throw new LedgerError('Those transactions were not found.', 'NOT_FOUND');
  }

  const { rows: applied } = await client.query(
    `SELECT id FROM corrections
      WHERE reversed_correlation_id = $1 AND status = 'Applied'`,
    [correlationId]
  );
  if (applied.length) {
    throw new LedgerError('That has already been corrected.', 'ALREADY_CORRECTED');
  }

  return rows;
}

/** Show what a correction would do. Writes nothing. */
export async function previewCorrection(ctx, { correlationId, reason }) {
  const { projectId } = ctx;

  return withTransaction(async (client) => {
    const transactions = await loadGroup(client, projectId, correlationId);

    const { rows: lineRows } = await client.query(
      `SELECT l.*, h.fmr_number FROM fmr_lines l
         JOIN fmr_headers h ON h.id = l.fmr_id
        WHERE l.id = $1`,
      [transactions[0].fmr_line_id]
    );
    const line = lineRows[0];
    if (!line) throw new LedgerError('That FMR line no longer exists.', 'NOT_FOUND');

    const plan = planCorrection(lineState(line), transactions, {
      reason: reason ?? 'preview'
    });

    return {
      correlationId,
      line: serializeLine(line),
      before: plan.before,
      after: plan.after,
      resultingStatus: plan.status,
      reverses: transactions.map((t) => ({
        id: String(t.id),
        type: t.transaction_type,
        quantity: Number(t.quantity),
        at: t.created_at,
        performedBy: t.performed_by_name
      }))
    };
  });
}

/**
 * Apply a correction.
 *
 * Writes inverse transactions, moves the ledger, and records what changed.
 * The original transactions are left exactly as they were.
 */
export async function applyCorrection(ctx, { correlationId, reason }) {
  const { user, projectId } = ctx;
  const correctionCorrelation = randomUUID();

  return withTransaction(async (client) => {
    const transactions = await loadGroup(client, projectId, correlationId);

    const { rows: lineRows } = await client.query(
      `SELECT l.*, h.fmr_number FROM fmr_lines l
         JOIN fmr_headers h ON h.id = l.fmr_id
        WHERE l.id = $1
        FOR UPDATE OF l`,
      [transactions[0].fmr_line_id]
    );
    const line = lineRows[0];
    if (!line) throw new LedgerError('That FMR line no longer exists.', 'NOT_FOUND');

    const plan = planCorrection(lineState(line), transactions, { reason });
    const after = plan.after;

    // Inverse entries: the correction's own record of what it undid.
    for (const inverse of plan.inverses) {
      await client.query(
        `INSERT INTO material_transactions
           (project_id, correlation_id, fmr_id, fmr_line_id, transaction_type,
            quantity, uom, performed_by, performed_by_name, source_bag_tag_id,
            target_bag_tag_id, backorder_request_id, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          projectId, correctionCorrelation, line.fmr_id, line.id,
          inverse.transaction_type, inverse.quantity, inverse.uom,
          user.id, user.display_name, inverse.sourceBagTagId,
          inverse.targetBagTagId, inverse.backorderRequestId,
          `Corrects transaction ${inverse.reversesTransactionId}: ${plan.reason}`
        ]
      );

      // The bag holding this material is a second record of it, and has to
      // move with the ledger.
      await reverseBagEffect(client, line.id, inverse);
    }

    await client.query(
      `UPDATE fmr_lines
          SET qty_confirmed_located   = $2,
              qty_active_bagged       = $3,
              qty_available           = $4,
              qty_issued              = $5,
              qty_pending_backorder   = $6,
              qty_confirmed_backorder = $7,
              line_status             = $8,
              updated_by = $9, updated_at = now()
        WHERE id = $1`,
      [
        line.id, after.confirmed, after.bagged, after.available, after.issued,
        after.pendingBackorder, after.confirmedBackorder, lineStatus(after), user.id
      ]
    );

    const { rows: correctionRows } = await client.query(
      `INSERT INTO corrections
         (project_id, fmr_id, fmr_line_id, correlation_id, reversed_correlation_id,
          transaction_types, reason, state_before, state_after,
          applied_by, applied_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id`,
      [
        projectId, line.fmr_id, line.id, correctionCorrelation, correlationId,
        plan.types, plan.reason, plan.before, plan.after, user.id, user.display_name
      ]
    );

    await client.query(
      `INSERT INTO audit_log
         (project_id, entity_type, entity_id, action, payload, user_id, user_email,
          source_interface, correlation_id)
       VALUES ($1,'FMR_LINE',$2,'OWNER_CORRECTION',$3,$4,$5,'OWNER',$6)`,
      [
        projectId, line.id,
        {
          correctionId: correctionRows[0].id,
          reversed: correlationId,
          types: plan.types,
          reason: plan.reason,
          before: plan.before,
          after: plan.after
        },
        user.id, user.email, correctionCorrelation
      ]
    );

    await sweepStaleNotices(client, line.id);
    // A correction moves quantities, so the FMR's own status can change with it.
    await client.query(HEADER_ROLLUP_SQL, [line.fmr_id, user.id]);

    const { rows: fresh } = await client.query(
      `SELECT l.*, h.fmr_number FROM fmr_lines l
         JOIN fmr_headers h ON h.id = l.fmr_id WHERE l.id = $1`,
      [line.id]
    );

    return {
      ok: true,
      correctionId: correctionRows[0].id,
      correlationId: correctionCorrelation,
      line: serializeLine(fresh[0])
    };
  });
}

/** Corrections applied on a project, most recent first. */
export async function getCorrectionHistory(client, projectId, limit = 100) {
  const { rows } = await client.query(
    `SELECT c.*, h.fmr_number, l.line_number, l.material_description
       FROM corrections c
       JOIN fmr_headers h ON h.id = c.fmr_id
       JOIN fmr_lines   l ON l.id = c.fmr_line_id
      WHERE c.project_id = $1
      ORDER BY c.applied_at DESC
      LIMIT $2`,
    [projectId, limit]
  );

  return rows.map((row) => ({
    id: row.id,
    fmrNumber: row.fmr_number,
    lineNumber: row.line_number,
    description: row.material_description,
    types: row.transaction_types,
    reason: row.reason,
    before: row.state_before,
    after: row.state_after,
    appliedBy: row.applied_by_name,
    appliedAt: row.applied_at
  }));
}
