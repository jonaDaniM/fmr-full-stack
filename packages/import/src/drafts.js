/**
 * Manual FMR drafts.
 *
 * An FMR arrives two ways: parsed out of a workbook, or typed in by hand.
 * Both need somewhere to sit and be corrected before the crews see them, so a
 * manual draft is a batch of one and goes through the same publish path as an
 * imported one — see publishBatch in staging.js.
 *
 * Ported from FMRv3's Owner staging workspace (OwnerService.gs,
 * StagingArchiveService.gs), with two deliberate changes:
 *
 *   - Lines are edited in place rather than superseded. FMRv3 appended a new
 *     generation on every save because a spreadsheet cannot cheaply update a
 *     row; the audit log already carries the history.
 *   - The one-active-draft-per-number rule is a unique index rather than a
 *     procedural check, so it also holds on create — FMRv3 only checked it on
 *     restore, which let two fresh drafts collide at publish instead.
 */

import { withTransaction } from '../../core/src/db/pool.js';
import { LedgerError } from '../../core/src/domain/ledger.js';
import { validateDraft, SEVERITY } from './validate.js';

const MIN_REASON = 3;

const clean = (v) => String(v ?? '').trim();

function requireReason(reason, what) {
  const value = clean(reason);
  if (value.length < MIN_REASON) {
    throw new LedgerError(
      `${what} needs a reason of at least ${MIN_REASON} characters.`,
      'MISSING_REASON'
    );
  }
  return value;
}

/** Record the current validation state against the draft. */
async function recordIssues(client, batchId, itemId, draft, { requireFmrNumber = false } = {}) {
  const result = validateDraft(draft, { requireFmrNumber });

  await client.query('DELETE FROM import_issues WHERE item_id = $1', [itemId]);

  for (const issue of result.issues) {
    await client.query(
      `INSERT INTO import_issues
         (batch_id, item_id, severity, code, message, field_name, source_row)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        batchId, itemId, issue.severity, issue.code, issue.message,
        issue.field ?? null, issue.lineNumber ?? null
      ]
    );
  }

  const errors = result.issues.filter((i) => i.severity === SEVERITY.ERROR).length;
  const warnings = result.issues.length - errors;

  await client.query(
    `UPDATE import_batches
        SET error_count = $2, warning_count = $3, line_count = $4
      WHERE id = $1`,
    [batchId, errors, warnings, draft.lines.length]
  );

  await client.query(
    `UPDATE import_items
        SET status = $2, selected = $3, line_count = $4
      WHERE id = $1`,
    [itemId, errors > 0 ? 'Blocked' : 'Ready', errors === 0, draft.lines.length]
  );

  return result;
}

/** Read a draft back in the shape the validator expects. */
export async function loadDraft(client, itemId) {
  const { rows: items } = await client.query(
    'SELECT * FROM import_items WHERE id = $1',
    [itemId]
  );
  const item = items[0];
  if (!item) throw new LedgerError('That draft was not found.', 'NOT_FOUND');

  const { rows: lines } = await client.query(
    'SELECT * FROM import_lines WHERE item_id = $1 ORDER BY line_number',
    [itemId]
  );

  return {
    item,
    draft: {
      header: {
        fmrNumber: item.fmr_number,
        iwpNumber: item.iwp_number,
        isoNumber: item.iso_number,
        isoRevision: item.iso_revision,
        isoSheet: item.iso_sheet,
        requestedBy: item.requested_by,
        dateRequired: item.date_required,
        priority: item.priority,
        notes: item.header_json?.notes
      },
      lines: lines.map((l) => ({
        id: l.id,
        commodityCode: l.commodity_code,
        size: l.size,
        description: l.description,
        quantity: l.quantity,
        uom: l.uom,
        storageLocation: l.storage_location
      }))
    }
  };
}

/** Refuse edits to a draft that has already gone out. */
async function assertEditable(client, itemId, projectId) {
  const { rows } = await client.query(
    `SELECT i.*, b.archived, b.published_at
       FROM import_items i
       JOIN import_batches b ON b.id = i.batch_id
      WHERE i.id = $1 AND i.project_id = $2
      FOR UPDATE OF i`,
    [itemId, projectId]
  );

  const item = rows[0];
  if (!item) throw new LedgerError('That draft was not found.', 'NOT_FOUND');
  if (item.published_fmr_id) {
    throw new LedgerError('That FMR has already been published.', 'PUBLISHED');
  }
  if (item.archived) {
    throw new LedgerError('That draft is archived. Restore it first.', 'ARCHIVED');
  }
  return item;
}

/** Start a new hand-written FMR. */
export async function createDraft(ctx, { header = {}, lines = [] } = {}) {
  const { user, projectId } = ctx;

  return withTransaction(async (client) => {
    const validation = validateDraft({ header, lines });
    const { header: h, lines: normalizedLines } = validation.normalized;

    const { rows: batchRows } = await client.query(
      `INSERT INTO import_batches
         (project_id, source, source_name, profile_name, sheet_count,
          line_count, created_by)
       VALUES ($1,'manual',NULL,'manual',1,$2,$3)
       RETURNING id`,
      [projectId, normalizedLines.length, user.id]
    );
    const batchId = batchRows[0].id;

    // Re-importing or re-typing an FMR that already exists is normal enough to
    // flag rather than refuse — the reviewer decides.
    const existing = h.fmrNumber
      ? (await client.query(
          'SELECT id FROM fmr_headers WHERE project_id = $1 AND fmr_number = $2',
          [projectId, h.fmrNumber]
        )).rows[0]?.id ?? null
      : null;

    let itemRows;
    try {
      ({ rows: itemRows } = await client.query(
        `INSERT INTO import_items
           (batch_id, project_id, sheet_name, fmr_number, iwp_number, iso_number,
            iso_sheet, requested_by, date_required, priority, header_json,
            line_count, status, selected, existing_fmr_id)
         VALUES ($1,$2,'Manual entry',$3,$4,$5,$6,$7,$8,$9,$10,$11,'Ready',true,$12)
         RETURNING id`,
        [
          batchId, projectId, h.fmrNumber, h.iwpNumber, h.isoNumber, h.isoSheet,
          h.requestedBy, h.dateRequired, h.priority,
          { notes: h.notes }, normalizedLines.length, existing
        ]
      ));
    } catch (error) {
      // one_active_draft_per_number: another unpublished draft already
      // holds this number. Say which, and what to do about it.
      if (error.code === '23505') {
        throw new LedgerError(
          `${h.fmrNumber} already has a draft waiting. Publish or archive that `
          + 'one first, or give this draft a different number.',
          'NUMBER_IN_USE'
        );
      }
      throw error;
    }

    const itemId = itemRows[0].id;

    for (const line of normalizedLines) {
      await client.query(
        `INSERT INTO import_lines
           (item_id, line_number, commodity_code, size, description,
            quantity, uom, uom_rule, storage_location)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          itemId, line.lineNumber, line.commodityCode, line.size,
          line.description, line.quantity, line.uom, line.uomRule,
          line.storageLocation
        ]
      );
    }

    await recordIssues(client, batchId, itemId, { header, lines });

    await client.query(
      `INSERT INTO audit_log
         (project_id, entity_type, entity_id, action, payload, user_id,
          user_email, source_interface)
       VALUES ($1,'DRAFT',$2,'DRAFT_CREATED',$3,$4,$5,'OWNER')`,
      [projectId, itemId, { fmrNumber: h.fmrNumber, lines: normalizedLines.length },
       user.id, user.email]
    );

    return { batchId, itemId, valid: validation.valid, issues: validation.issues };
  });
}

/** Edit the header of a draft. */
export async function updateDraftHeader(ctx, { itemId, patch = {} }) {
  const { user, projectId } = ctx;

  return withTransaction(async (client) => {
    const item = await assertEditable(client, itemId, projectId);
    const { draft } = await loadDraft(client, itemId);

    const merged = { ...draft, header: { ...draft.header, ...patch } };
    const validation = validateDraft(merged);
    const h = validation.normalized.header;

    try {
      await client.query(
        `UPDATE import_items
            SET fmr_number = $2, iwp_number = $3, iso_number = $4, iso_sheet = $5,
                requested_by = $6, date_required = $7, priority = $8,
                header_json = $9
          WHERE id = $1`,
        [
          itemId, h.fmrNumber, h.iwpNumber, h.isoNumber, h.isoSheet,
          h.requestedBy, h.dateRequired, h.priority, { notes: h.notes }
        ]
      );
    } catch (error) {
      // one_active_draft_per_number. Numbering a draft is exactly when this
      // collides, and the raw error reached the office as "something went
      // wrong, try again" — advice that cannot work, so it was tried five
      // times. Name the number and say what to do about it.
      if (error.code === '23505') {
        throw new LedgerError(
          `${h.fmrNumber} already has a draft waiting. Publish or archive that `
          + 'one first, or give this draft a different number.',
          'NUMBER_IN_USE'
        );
      }
      throw error;
    }

    await recordIssues(client, item.batch_id, itemId, merged);

    return { ok: true, valid: validation.valid, issues: validation.issues };
  });
}

/** Add a line, or edit one already there. */
export async function saveDraftLine(ctx, { itemId, line = {} }) {
  const { projectId } = ctx;

  return withTransaction(async (client) => {
    const item = await assertEditable(client, itemId, projectId);
    const { draft } = await loadDraft(client, itemId);

    const merged = { ...draft };
    if (line.id) {
      merged.lines = draft.lines.map((l) => (l.id === line.id ? { ...l, ...line } : l));
    } else {
      merged.lines = [...draft.lines, line];
    }

    const validation = validateDraft(merged);
    const normalized = validation.normalized.lines;

    if (line.id) {
      const index = merged.lines.findIndex((l) => l.id === line.id);
      const n = normalized[index];
      await client.query(
        `UPDATE import_lines
            SET commodity_code = $2, size = $3, description = $4,
                quantity = $5, uom = $6, uom_rule = $7, storage_location = $8
          WHERE id = $1`,
        [
          line.id, n.commodityCode, n.size, n.description,
          n.quantity, n.uom, n.uomRule, n.storageLocation
        ]
      );
    } else {
      const n = normalized[normalized.length - 1];
      await client.query(
        `INSERT INTO import_lines
           (item_id, line_number, commodity_code, size, description,
            quantity, uom, uom_rule, storage_location)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          itemId, n.lineNumber, n.commodityCode, n.size, n.description,
          n.quantity, n.uom, n.uomRule, n.storageLocation
        ]
      );
    }

    await recordIssues(client, item.batch_id, itemId, merged);

    return { ok: true, valid: validation.valid, issues: validation.issues };
  });
}

/** Remove a line, renumbering the rest so the sequence has no holes. */
export async function deleteDraftLine(ctx, { lineId }) {
  const { projectId } = ctx;

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT l.item_id FROM import_lines l
         JOIN import_items i ON i.id = l.item_id
        WHERE l.id = $1 AND i.project_id = $2`,
      [lineId, projectId]
    );
    if (!rows[0]) throw new LedgerError('That line was not found.', 'NOT_FOUND');

    const itemId = rows[0].item_id;
    const item = await assertEditable(client, itemId, projectId);

    // The import review screen refuses this and so must the draft editor: the
    // same action on the same FMR should not depend on which screen a planner
    // happens to be on. Deleting it here used to leave an FMR with no material,
    // caught only afterwards by NO_LINES — an error about a state that should
    // never have been reachable. Archiving is the way to put a whole FMR aside.
    const { rows: counted } = await client.query(
      'SELECT count(*)::int AS n FROM import_lines WHERE item_id = $1',
      [itemId]
    );
    if (counted[0].n <= 1) {
      throw new LedgerError(
        'That is the last line on this FMR. Archive the whole FMR instead.',
        'LAST_LINE'
      );
    }

    await client.query('DELETE FROM import_lines WHERE id = $1', [lineId]);

    // Renumber so the crew sees 1..n, not a gap where the deletion was.
    await client.query(
      `UPDATE import_lines l
          SET line_number = ordered.position
         FROM (
           SELECT id, row_number() OVER (ORDER BY line_number) AS position
             FROM import_lines WHERE item_id = $1
         ) ordered
        WHERE l.id = ordered.id`,
      [itemId]
    );

    const { draft } = await loadDraft(client, itemId);
    const validation = await recordIssues(client, item.batch_id, itemId, draft);

    return { ok: true, valid: validation.valid, issues: validation.issues };
  });
}

/** Take a draft out of the working queue without losing it. */
export async function archiveDraft(ctx, { batchId, reason }) {
  const { user, projectId } = ctx;
  const why = requireReason(reason, 'Archiving');

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM import_batches
        WHERE id = $1 AND project_id = $2 FOR UPDATE`,
      [batchId, projectId]
    );

    const batch = rows[0];
    if (!batch) throw new LedgerError('That draft was not found.', 'NOT_FOUND');
    if (batch.archived) throw new LedgerError('That draft is already archived.', 'ARCHIVED');
    if (batch.published_at) {
      throw new LedgerError('A published FMR cannot be archived here.', 'PUBLISHED');
    }

    await client.query(
      `UPDATE import_batches
          SET archived = true, archive_reason = $2, archived_by = $3, archived_at = now()
        WHERE id = $1`,
      [batchId, why, user.id]
    );
    // Mirrored onto items so the partial unique index releases the FMR number.
    await client.query(
      'UPDATE import_items SET archived = true WHERE batch_id = $1',
      [batchId]
    );

    await client.query(
      `INSERT INTO audit_log
         (project_id, entity_type, entity_id, action, payload, user_id,
          user_email, source_interface)
       VALUES ($1,'DRAFT',$2,'DRAFT_ARCHIVED',$3,$4,$5,'OWNER')`,
      [projectId, batchId, { reason: why }, user.id, user.email]
    );

    return { ok: true, archived: true };
  });
}

/**
 * Put an archived draft back in the queue.
 *
 * Keeps the same id, as FMRv3 did. If another draft has taken its FMR number
 * while it was away, the unique index refuses — that is the rule FMRv3 checked
 * by hand here.
 */
export async function restoreDraft(ctx, { batchId, reason }) {
  const { user, projectId } = ctx;
  const why = requireReason(reason, 'Restoring');

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM import_batches
        WHERE id = $1 AND project_id = $2 FOR UPDATE`,
      [batchId, projectId]
    );

    const batch = rows[0];
    if (!batch) throw new LedgerError('That draft was not found.', 'NOT_FOUND');
    if (!batch.archived) throw new LedgerError('That draft is not archived.', 'NOT_ARCHIVED');

    try {
      await client.query(
        'UPDATE import_items SET archived = false WHERE batch_id = $1',
        [batchId]
      );
    } catch (error) {
      if (error.code === '23505') {
        throw new LedgerError(
          'Another active draft already uses that FMR number. ' +
          'Archive the other one before restoring this.',
          'NUMBER_IN_USE'
        );
      }
      throw error;
    }

    await client.query(
      `UPDATE import_batches
          SET archived = false, archive_reason = NULL,
              archived_by = NULL, archived_at = NULL
        WHERE id = $1`,
      [batchId]
    );

    await client.query(
      `INSERT INTO audit_log
         (project_id, entity_type, entity_id, action, payload, user_id,
          user_email, source_interface)
       VALUES ($1,'DRAFT',$2,'DRAFT_RESTORED',$3,$4,$5,'OWNER')`,
      [projectId, batchId, { reason: why }, user.id, user.email]
    );

    return { ok: true, archived: false };
  });
}

/**
 * Everything unpublished, active and archived kept apart.
 *
 * Both kinds of draft appear together: where an FMR came from stops mattering
 * once it is in the queue.
 */
export async function listDrafts(client, projectId, { source, includeArchived = true } = {}) {
  const { rows } = await client.query(
    `SELECT b.id, b.source, b.source_name, b.archived, b.archive_reason,
            b.created_at,
            -- Every count on this card describes one FMR, so none of them may
            -- come from the batch. Reading the batch totals put "90 lines" on
            -- all 26 cards of a package, and marked all 26 with an error when
            -- a single quantity on one of them had been mistyped. Only a batch
            -- with no item yet falls back to the batch's own figures.
            coalesce(i.line_count, b.line_count) AS line_count,
            coalesce(q.errors, b.error_count) AS error_count,
            coalesce(q.warnings, b.warning_count) AS warning_count,
            u.display_name AS created_by_name,
            i.id AS item_id, i.fmr_number, i.iwp_number, i.iso_number,
            i.iso_sheet, i.iso_revision, i.requested_by, i.date_required,
            i.priority,
            i.status, i.existing_fmr_id
       FROM import_batches b
       LEFT JOIN import_items i ON i.batch_id = b.id
       LEFT JOIN (
         SELECT item_id,
                count(*) FILTER (WHERE severity = 'error' AND NOT resolved) AS errors,
                count(*) FILTER (WHERE severity = 'warning' AND NOT resolved) AS warnings
           FROM import_issues WHERE item_id IS NOT NULL GROUP BY item_id
       ) q ON q.item_id = i.id
       LEFT JOIN users u ON u.id = b.created_by
      WHERE b.project_id = $1
        AND b.published_at IS NULL
        AND ($2::text IS NULL OR b.source = $2)
        AND ($3::boolean OR NOT b.archived)
      ORDER BY b.archived, b.created_at DESC`,
    [projectId, source ?? null, includeArchived]
  );

  const drafts = rows.map((row) => ({
    batchId: row.id,
    itemId: row.item_id,
    source: row.source,
    sourceName: row.source_name,
    archived: row.archived,
    archiveReason: row.archive_reason,
    fmrNumber: row.fmr_number,
    iwpNumber: row.iwp_number,
    isoNumber: row.iso_number,
    isoSheet: row.iso_sheet,
    isoRevision: row.iso_revision,
    requestedBy: row.requested_by,
    dateRequired: row.date_required,
    priority: row.priority,
    status: row.status,
    // Numbers, not the strings pg returns for count(): the queue tile tests
    // these for truthiness, and "0" is true — which marked all 26 drafts as
    // having errors when one of them had a single mistyped quantity.
    lineCount: Number(row.line_count),
    errorCount: Number(row.error_count),
    warningCount: Number(row.warning_count),
    isDuplicate: !!row.existing_fmr_id,
    createdBy: row.created_by_name,
    createdAt: row.created_at
  }));

  return {
    active: drafts.filter((d) => !d.archived),
    archived: drafts.filter((d) => d.archived)
  };
}

/**
 * Re-validate a draft the way publishing will.
 *
 * The screen calls this before offering the publish button, so the button
 * reflects the rules the server will actually apply rather than a stored flag
 * that may be stale — which is how FMRv3's could disagree with its own server.
 */
export async function checkDraftForPublish(client, projectId, itemId) {
  const { rows } = await client.query(
    'SELECT id FROM import_items WHERE id = $1 AND project_id = $2',
    [itemId, projectId]
  );
  if (!rows[0]) throw new LedgerError('That draft was not found.', 'NOT_FOUND');

  const { draft } = await loadDraft(client, itemId);
  const result = validateDraft(draft, { requireFmrNumber: true });

  return {
    valid: result.valid,
    issues: result.issues,
    canPublish: result.valid
  };
}
