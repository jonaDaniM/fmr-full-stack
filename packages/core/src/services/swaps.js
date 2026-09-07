/**
 * Line swap: the service layer.
 *
 * One transaction covers both lines. The two rows are locked in a fixed order
 * — lowest line id first — because two crews borrowing from each other at the
 * same moment would otherwise each hold what the other needs and deadlock.
 * Ordering the locks makes that impossible rather than rare.
 */

import { randomUUID } from 'node:crypto';
import { withTransaction } from '../db/pool.js';
import { LedgerError, lineState, lineStatus } from '../domain/ledger.js';
import {
  SWAP_STATUS, planSwap, applyLend, applyBorrow, planRepayment,
  isCompatible, lendableQuantity
} from '../domain/swap.js';
import { HEADER_ROLLUP_SQL } from './field.js';
import { assertFieldOpen } from './controls.js';

const LINE_SQL = `
  SELECT l.*, h.fmr_number
    FROM fmr_lines l
    JOIN fmr_headers h ON h.id = l.fmr_id
   WHERE l.id = $1 AND l.project_id = $2`;

/**
 * Lock both lines, lowest id first.
 *
 * Postgres orders rows by whatever the plan produces, so the ordering has to
 * be imposed here rather than left to a single query with two ids.
 */
async function lockPair(client, projectId, donorId, receiverId) {
  const [first, second] = [donorId, receiverId].sort();

  const locked = new Map();
  for (const id of [first, second]) {
    const { rows } = await client.query(`${LINE_SQL} FOR UPDATE OF l`, [id, projectId]);
    const line = rows[0];
    if (!line) throw new LedgerError('FMR line not found.', 'NOT_FOUND');
    if (!line.active) throw new LedgerError('This FMR line is inactive.', 'INACTIVE');
    locked.set(id, line);
  }

  return { donor: locked.get(donorId), receiver: locked.get(receiverId) };
}

async function persist(client, line, state, userId) {
  await client.query(
    `UPDATE fmr_lines
        SET qty_confirmed_located = $2, qty_active_bagged = $3, qty_available = $4,
            qty_issued = $5, line_status = $6, updated_by = $7, updated_at = now()
      WHERE id = $1`,
    [line.id, state.confirmed, state.bagged, state.available, state.issued,
      lineStatus(state), userId]
  );
}

async function recordMovement(client, line, type, quantity, user, details) {
  await client.query(
    `INSERT INTO material_transactions
       (project_id, correlation_id, fmr_id, fmr_line_id, transaction_type, quantity,
        uom, performed_by, performed_by_name, issued_to_name, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [line.project_id, details.correlationId, line.fmr_id, line.id, type, quantity,
      line.uom, user.id, user.display_name, details.issuedToName ?? null,
      details.notes ?? null]
  );
}

async function audit(client, projectId, entityId, action, user, correlationId, payload) {
  await client.query(
    `INSERT INTO audit_log
       (project_id, entity_type, entity_id, action, payload, user_id, user_email,
        source_interface, correlation_id)
     VALUES ($1,'LINE_SWAP',$2,$3,$4,$5,$6,'FIELD',$7)`,
    [projectId, entityId, action, payload, user.id, user.email, correlationId]
  );
}

/**
 * Candidate donor lines for a line that is short.
 *
 * Matched on commodity code, size and unit of measure, and ranked by what is
 * actually on the shelf. Only lines with material available appear — a line
 * that has nothing to lend is not a candidate, it is noise.
 */
export async function findDonors(client, ctx, { lineId, limit = 25 }) {
  const { rows: target } = await client.query(LINE_SQL, [lineId, ctx.projectId]);
  const receiver = target[0];
  if (!receiver) throw new LedgerError('FMR line not found.', 'NOT_FOUND');

  if (!String(receiver.commodity_code ?? '').trim()) {
    return { receiver, donors: [], reason: 'NO_COMMODITY_CODE' };
  }

  const { rows } = await client.query(
    `SELECT l.*, h.fmr_number
       FROM fmr_lines l
       JOIN fmr_headers h ON h.id = l.fmr_id
      WHERE l.project_id = $1
        AND l.id <> $2
        AND l.active
        AND l.qty_available > 0
        AND upper(trim(coalesce(l.commodity_code,''))) = upper(trim($3))
        AND upper(trim(coalesce(l.size,'')))           = upper(trim(coalesce($4,'')))
        AND upper(trim(coalesce(l.uom,'')))            = upper(trim(coalesce($5,'')))
      ORDER BY l.qty_available DESC, h.fmr_number
      LIMIT $6`,
    [ctx.projectId, lineId, receiver.commodity_code, receiver.size, receiver.uom, limit]
  );

  return {
    receiver,
    donors: rows.filter((d) => isCompatible(d, receiver)).map((d) => ({
      lineId: d.id,
      fmrId: d.fmr_id,
      fmrNumber: d.fmr_number,
      lineNumber: d.line_number,
      isoNumber: d.iso_number,
      isoRevision: d.iso_revision,
      description: d.material_description,
      commodityCode: d.commodity_code,
      size: d.size,
      uom: d.uom,
      lendable: lendableQuantity(lineState(d))
    }))
  };
}

/**
 * Borrow material from one line for another.
 *
 * Physical movement and obligation are written together but kept as separate
 * records: two material_transactions rows sharing a correlation_id, and one
 * line_swaps row carrying the debt.
 */
export async function borrowMaterial(ctx, {
  donorLineId, receiverLineId, quantity, reason, issuedToName
}) {
  return withTransaction(async (client) => {
    await assertFieldOpen(client, ctx.projectId);

    const { donor, receiver } = await lockPair(
      client, ctx.projectId, donorLineId, receiverLineId
    );

    const donorState = lineState(donor);
    const receiverState = lineState(receiver);

    const qty = planSwap({ donor, donorState, receiver, receiverState, quantity });

    applyLend(donorState, qty);
    applyBorrow(receiverState, qty);

    const correlationId = randomUUID();

    await persist(client, donor, donorState, ctx.user.id);
    await persist(client, receiver, receiverState, ctx.user.id);

    const { rows } = await client.query(
      `INSERT INTO line_swaps
         (project_id, donor_fmr_id, donor_line_id, receiver_fmr_id, receiver_line_id,
          commodity_code, size, uom, qty_borrowed, reason, borrowed_by,
          borrowed_by_name, issued_to_name, correlation_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [ctx.projectId, donor.fmr_id, donor.id, receiver.fmr_id, receiver.id,
        donor.commodity_code, donor.size, donor.uom, qty, reason ?? null,
        ctx.user.id, ctx.user.display_name, issuedToName ?? null, correlationId,
        SWAP_STATUS.OPEN]
    );
    const swap = rows[0];

    await recordMovement(client, donor, 'SWAP_LENT', -qty, ctx.user, {
      correlationId,
      notes: `Lent to ${receiver.fmr_number} line ${receiver.line_number}`
    });
    await recordMovement(client, receiver, 'SWAP_BORROWED', qty, ctx.user, {
      correlationId, issuedToName,
      notes: `Borrowed from ${donor.fmr_number} line ${donor.line_number}`
    });

    await client.query(HEADER_ROLLUP_SQL, [donor.fmr_id, ctx.user.id]);
    await client.query(HEADER_ROLLUP_SQL, [receiver.fmr_id, ctx.user.id]);

    await audit(client, ctx.projectId, swap.id, 'SWAP_BORROWED', ctx.user,
      correlationId, {
        donor: `${donor.fmr_number} line ${donor.line_number}`,
        receiver: `${receiver.fmr_number} line ${receiver.line_number}`,
        quantity: qty, uom: donor.uom, reason: reason ?? null
      });

    return { swap, donorStatus: lineStatus(donorState), receiverStatus: lineStatus(receiverState) };
  });
}

/**
 * Record replacement material arriving for the donor.
 *
 * This settles the debt only. It does not put material back on the donor's
 * shelf — that is a locate, and the crew does it when the steel is physically
 * there. Conflating the two would credit a line with material nobody has seen.
 */
export async function repaySwap(ctx, { swapId, quantity, notes }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM line_swaps WHERE id = $1 AND project_id = $2 FOR UPDATE`,
      [swapId, ctx.projectId]
    );
    const swap = rows[0];
    if (!swap) throw new LedgerError('Swap not found.', 'NOT_FOUND');

    const plan = planRepayment(swap, quantity);
    const correlationId = randomUUID();

    await client.query(
      `UPDATE line_swaps
          SET qty_repaid = $2::numeric, status = $3, updated_at = now()
        WHERE id = $1::uuid`,
      [swap.id, plan.qtyRepaid, plan.status]
    );

    await client.query(
      `INSERT INTO line_swap_repayments
         (swap_id, project_id, quantity, notes, recorded_by, recorded_by_name,
          correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [swap.id, ctx.projectId, plan.applied, notes ?? null, ctx.user.id,
        ctx.user.display_name, correlationId]
    );

    await audit(client, ctx.projectId, swap.id, 'SWAP_REPAID', ctx.user,
      correlationId,
      { quantity: plan.applied, outstanding: plan.outstanding, status: plan.status });

    return { ...swap, qty_repaid: plan.qtyRepaid, status: plan.status,
      qty_outstanding: plan.outstanding };
  });
}

/**
 * The admin queue: what is still owed, oldest first.
 *
 * Aging is what makes this queue worth having — an obligation nobody chases is
 * the paper note this feature replaced.
 */
export async function openSwaps(client, ctx, { includeSettled = false } = {}) {
  const { rows } = await client.query(
    `SELECT s.*,
            dh.fmr_number AS donor_fmr_number,    dl.line_number AS donor_line_number,
            dl.material_description AS donor_description, dl.iso_number AS donor_iso,
            rh.fmr_number AS receiver_fmr_number, rl.line_number AS receiver_line_number,
            rl.iso_number AS receiver_iso,
            EXTRACT(DAY FROM now() - s.created_at)::int AS age_days
       FROM line_swaps s
       JOIN fmr_headers dh ON dh.id = s.donor_fmr_id
       JOIN fmr_lines   dl ON dl.id = s.donor_line_id
       JOIN fmr_headers rh ON rh.id = s.receiver_fmr_id
       JOIN fmr_lines   rl ON rl.id = s.receiver_line_id
      WHERE s.project_id = $1
        AND ($2::boolean OR s.status IN ('Open', 'Partially Repaid'))
      ORDER BY s.created_at ASC`,
    [ctx.projectId, includeSettled]
  );
  return rows;
}

/** Swaps touching one line, from either side — what it owes and what it is owed. */
export async function swapsForLine(client, ctx, lineId) {
  const { rows } = await client.query(
    `SELECT s.*,
            dh.fmr_number AS donor_fmr_number, dl.line_number AS donor_line_number,
            rh.fmr_number AS receiver_fmr_number, rl.line_number AS receiver_line_number
       FROM line_swaps s
       JOIN fmr_headers dh ON dh.id = s.donor_fmr_id
       JOIN fmr_lines   dl ON dl.id = s.donor_line_id
       JOIN fmr_headers rh ON rh.id = s.receiver_fmr_id
       JOIN fmr_lines   rl ON rl.id = s.receiver_line_id
      WHERE s.project_id = $1 AND (s.donor_line_id = $2 OR s.receiver_line_id = $2)
      ORDER BY s.created_at DESC`,
    [ctx.projectId, lineId]
  );
  return rows;
}
