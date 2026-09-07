/**
 * Import staging.
 *
 * A parsed workbook becomes a batch that someone reviews before any of it
 * becomes a real FMR. Nothing here writes to fmr_headers or fmr_lines until
 * publish is called, and publish refuses a batch that still has errors.
 */

import { withTransaction } from '../../core/src/db/pool.js';
import { extractWorkbook, SEVERITY } from './extract.js';
import { validateDraft } from './validate.js';
import { LedgerError } from '../../core/src/domain/ledger.js';
import { STATES, STATE_LABELS } from '../../core/src/domain/workflow.js';

/** Parse a workbook and stage it for review. */
export async function stageWorkbook(ctx, { sheets, sourceName, profile, profileName,
                                            preExtracted }) {
  const { user, projectId } = ctx;

  // Rows that arrived already parsed — from the drawing extractor — skip the
  // workbook reader and come straight in.
  const extraction = preExtracted
    ? {
        sheets: preExtracted,
        summary: {
          sheets: preExtracted.length,
          lines: preExtracted.reduce((t, s) => t + s.lines.length, 0),
          errors: preExtracted.reduce(
            (t, s) => t + s.issues.filter((i) => i.severity === 'error').length, 0),
          warnings: preExtracted.reduce(
            (t, s) => t + s.issues.filter((i) => i.severity === 'warning').length, 0)
        }
      }
    : extractWorkbook(sheets, profile);

  return withTransaction(async (client) => {
    const { rows: batchRows } = await client.query(
      `INSERT INTO import_batches
         (project_id, source_name, profile_name, sheet_count, line_count,
          error_count, warning_count, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [
        projectId, sourceName, profileName ?? 'default',
        extraction.summary.sheets, extraction.summary.lines,
        extraction.summary.errors, extraction.summary.warnings, user.id
      ]
    );
    const batchId = batchRows[0].id;

    for (const sheet of extraction.sheets) {
      const hasErrors = sheet.issues.some((i) => i.severity === SEVERITY.ERROR);

      // Does this FMR already exist? Re-importing a revised sheet is normal,
      // so flag it rather than creating a duplicate.
      let existingFmrId = null;
      let waitingAlready = false;
      if (sheet.header.fmrNumber) {
        const { rows } = await client.query(
          `SELECT id FROM fmr_headers WHERE project_id = $1 AND fmr_number = $2`,
          [projectId, sheet.header.fmrNumber]
        );
        existingFmrId = rows[0]?.id ?? null;

        // And is one already waiting in the queue under that number? Only one
        // may be, by index, so a second would fail at the insert — which read
        // as "those drawings could not be read" rather than the truth, that
        // the same package is already staged.
        const { rows: staged } = await client.query(
          `SELECT id FROM import_items
            WHERE project_id = $1 AND upper(fmr_number) = upper($2)
              AND published_fmr_id IS NULL AND NOT archived`,
          [projectId, sheet.header.fmrNumber]
        );
        waitingAlready = staged.length > 0;
      }

      // Its number is dropped rather than the sheet: the material is still
      // worth reviewing, and the reviewer gives it a number that is free.
      const fmrNumber = waitingAlready ? null : sheet.header.fmrNumber ?? null;
      if (waitingAlready) {
        sheet.issues.push({
          severity: SEVERITY.WARNING,
          code: 'ALREADY_STAGED',
          message: `${sheet.header.fmrNumber} is already waiting in the queue. `
            + 'Give this one a number before publishing, or discard it.',
          row: null,
          sourceRow: null
        });
      }

      const { rows: itemRows } = await client.query(
        `INSERT INTO import_items
           (batch_id, project_id, sheet_name, fmr_number, iwp_number, iso_number,
            iso_sheet, iso_revision, requested_by, date_required, priority,
            header_json, line_count, status, selected, existing_fmr_id)
         VALUES ($1,$16,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING id`,
        [
          batchId, sheet.sheetName, fmrNumber,
          sheet.header.iwpNumber ?? null, sheet.header.isoNumber ?? null,
          sheet.header.isoSheet ?? null,
          // The revision a crew works to. Read off the title block by the
          // drawing extractor, and until now kept only inside header_json
          // where nothing could query or display it.
          sheet.header.revision ?? null,
          sheet.header.requestedBy ?? null,
          parseDate(sheet.header.dateRequired), sheet.header.priority ?? null,
          sheet.header, sheet.lines.length,
          hasErrors || waitingAlready ? 'Blocked'
            : existingFmrId ? 'Duplicate' : 'Ready',
          !hasErrors && !existingFmrId && !waitingAlready,
          existingFmrId,
          projectId
        ]
      );
      const itemId = itemRows[0].id;

      for (const line of sheet.lines) {
        await client.query(
          `INSERT INTO import_lines
             (item_id, line_number, source_row, commodity_code, size, description,
              quantity, uom, uom_rule, storage_location)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            itemId, line.lineNumber, line.sourceRow, line.commodityCode,
            line.size, line.description, line.quantity, line.uom,
            line.uomRule, line.storageLocation
          ]
        );
      }

      for (const issue of sheet.issues) {
        await client.query(
          `INSERT INTO import_issues
             (batch_id, item_id, sheet_name, severity, code, message,
              field_name, source_row, source_value)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            // source_row anchors an issue to the row of the source file a
            // person can open and check — the same number import_lines stores,
            // which is what lets the review screen mark the offending row.
            // `issue.row` is the line's position within its drawing and is a
            // different number; using it here left every anchor unmatchable.
            batchId, itemId, sheet.sheetName, issue.severity, issue.code,
            issue.message, issue.field ?? null, issue.sourceRow ?? issue.row ?? null,
            issue.value ?? null
          ]
        );
      }
    }

    // Counted after the loop, not before it: staging can add an issue of its
    // own — a number already waiting in the queue — and the tiles on the
    // review screen have to agree with the rows underneath them.
    const summary = {
      ...extraction.summary,
      errors: extraction.sheets.reduce(
        (t, s) => t + s.issues.filter((i) => i.severity === SEVERITY.ERROR).length, 0),
      warnings: extraction.sheets.reduce(
        (t, s) => t + s.issues.filter((i) => i.severity === SEVERITY.WARNING).length, 0)
    };

    await client.query(
      `UPDATE import_batches SET error_count = $2, warning_count = $3 WHERE id = $1`,
      [batchId, summary.errors, summary.warnings]
    );

    return { batchId, summary };
  });
}

/** A staged batch with everything a reviewer needs to see. */
export async function getBatch(client, projectId, batchId) {
  const { rows: batches } = await client.query(
    `SELECT * FROM import_batches WHERE id = $1 AND project_id = $2`,
    [batchId, projectId]
  );
  if (!batches[0]) return null;

  const { rows: items } = await client.query(
    `SELECT * FROM import_items WHERE batch_id = $1 ORDER BY sheet_name`,
    [batchId]
  );

  const { rows: issues } = await client.query(
    `SELECT * FROM import_issues WHERE batch_id = $1 ORDER BY severity, source_row`,
    [batchId]
  );

  const { rows: lines } = await client.query(
    `SELECT l.* FROM import_lines l
       JOIN import_items i ON i.id = l.item_id
      WHERE i.batch_id = $1
      ORDER BY l.item_id, l.line_number`,
    [batchId]
  );

  const linesByItem = {};
  for (const line of lines) (linesByItem[line.item_id] ??= []).push(line);

  const issuesByItem = {};
  for (const issue of issues) (issuesByItem[issue.item_id] ??= []).push(issue);

  return {
    id: batches[0].id,
    sourceName: batches[0].source_name,
    profileName: batches[0].profile_name,
    status: batches[0].status,
    createdAt: batches[0].created_at,
    publishedAt: batches[0].published_at,
    summary: {
      sheets: batches[0].sheet_count,
      lines: batches[0].line_count,
      errors: batches[0].error_count,
      warnings: batches[0].warning_count
    },
    items: items.map((item) => ({
      id: item.id,
      sheetName: item.sheet_name,
      fmrNumber: item.fmr_number,
      iwpNumber: item.iwp_number,
      isoNumber: item.iso_number,
      isoRevision: item.iso_revision,
      isoSheet: item.iso_sheet,
      requestedBy: item.requested_by,
      dateRequired: item.date_required,
      priority: item.priority,
      status: item.status,
      selected: item.selected,
      isDuplicate: !!item.existing_fmr_id,
      publishedFmrId: item.published_fmr_id,
      lines: (linesByItem[item.id] ?? []).map((l) => ({
        id: l.id,
        lineNumber: l.line_number,
        sourceRow: l.source_row,
        commodityCode: l.commodity_code,
        size: l.size,
        description: l.description,
        quantity: l.quantity == null ? null : Number(l.quantity),
        uom: l.uom,
        uomRule: l.uom_rule,
        // Left out, so the draft editor drew an empty Location for a line that
        // had one — and that cell is editable, so leaving it alone was enough
        // to write the blank back over a real storage location.
        storageLocation: l.storage_location
      })),
      issues: (issuesByItem[item.id] ?? []).map(serializeIssue)
    }))
  };
}

/** Correct a staged line before publishing. */
export async function correctLine(ctx, { lineId, patch }) {
  const allowed = ['commodity_code', 'size', 'description', 'quantity', 'uom',
                   'storage_location'];

  const fields = Object.entries(patch ?? {})
    .map(([key, value]) => [toSnake(key), value])
    .filter(([key]) => allowed.includes(key));

  if (!fields.length) throw new LedgerError('Nothing to change.', 'NO_CHANGE');

  const set = fields.map(([key], i) => `${key} = $${i + 2}`).join(', ');

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE import_lines l
          SET ${set}
         FROM import_items i, import_batches b
        WHERE l.id = $1
          AND i.id = l.item_id AND b.id = i.batch_id
          AND b.project_id = $${fields.length + 2}
          AND b.published_at IS NULL
        RETURNING l.*`,
      [lineId, ...fields.map(([, v]) => v), ctx.projectId]
    );

    if (!rows[0]) {
      throw new LedgerError('That line is not in an unpublished batch.', 'NOT_FOUND');
    }

    await revalidateLine(client, rows[0]);
    return rows[0];
  });
}

/**
 * Re-check one line after it has been edited by hand, and reconcile the issues
 * recorded against it.
 *
 * Validation used to run only while staging a file, so a value typed into the
 * review screen was never checked again: clearing a quantity stored a 0, no
 * issue was written, the tiles still read zero errors, and the batch published
 * a line telling a crew to go and find nothing. The parser's own fail-safe was
 * working the whole time — it was the correction path that had none.
 *
 * Issues from the original parse are anchored by `source_row`; these are
 * anchored by `field_name` as well, so a re-edit replaces its own rows and
 * leaves the parse's untouched.
 */
async function revalidateLine(client, line) {
  const { rows: context } = await client.query(
    `SELECT i.id AS item_id, i.batch_id, i.sheet_name
       FROM import_items i WHERE i.id = $1`,
    [line.item_id]
  );
  const { item_id: itemId, batch_id: batchId, sheet_name: sheetName } = context[0];

  // Validated on its own: one edited line says nothing about whether the FMR
  // still has a number or a drawing, and re-checking the header here would
  // raise issues the person did not touch.
  const { issues } = validateDraft(
    { header: {}, lines: [lineToDraft(line)] },
    { requireFmrNumber: false }
  );
  // `validateDraft` checks the header too, and an empty one raises a missing
  // drawing and sheet that have nothing to do with the cell just edited. Only
  // issues carrying a line number belong to the line.
  const lineIssues = issues.filter((i) => i.lineNumber != null);

  await client.query(
    `DELETE FROM import_issues
      WHERE item_id = $1 AND source_row = $2 AND field_name = 'edited'`,
    [itemId, line.source_row]
  );

  for (const issue of lineIssues) {
    await client.query(
      `INSERT INTO import_issues
         (batch_id, item_id, sheet_name, severity, code, message,
          field_name, source_row, source_value)
       VALUES ($1,$2,$3,$4,$5,$6,'edited',$7,$8)`,
      [batchId, itemId, sheetName, issue.severity, issue.code, issue.message,
       line.source_row, String(line.quantity ?? '')]
    );
  }

  await recountBatch(client, batchId);
}

/** The shape `validateDraft` reads, from a stored row. */
const lineToDraft = (line) => ({
  commodityCode: line.commodity_code,
  size: line.size,
  description: line.description,
  quantity: line.quantity,
  uom: line.uom,
  storageLocation: line.storage_location
});

/**
 * Bring a batch's counters back in line with what it actually holds.
 *
 * All four are written once while staging a file and were never recomputed, so
 * removing a line or a whole FMR left the tiles reading the size of the file as
 * it arrived rather than the queue as it stands — a planner who dropped two
 * drawings still saw 26 Sheets over a list of 24. The counts and the rows
 * underneath them have to agree, or the screen is not worth reading.
 *
 * The tiles and the publish gate also read different things — the tiles read
 * these counts, the gate counts unresolved error rows — so both are derived
 * here from the same rows.
 */
async function recountBatch(client, batchId) {
  await client.query(
    `UPDATE import_batches b
        SET sheet_count = c.sheets,
            line_count = c.lines,
            error_count = i.errors,
            warning_count = i.warnings
       FROM (
         SELECT count(DISTINCT it.id) AS sheets, count(l.id) AS lines
           FROM import_items it
           LEFT JOIN import_lines l ON l.item_id = it.id
          WHERE it.batch_id = $1
       ) c,
       (
         SELECT
           count(*) FILTER (WHERE severity = 'error' AND NOT resolved) AS errors,
           count(*) FILTER (WHERE severity = 'warning' AND NOT resolved) AS warnings
           FROM import_issues WHERE batch_id = $1
       ) i
      WHERE b.id = $1`,
    [batchId]
  );
}

/**
 * Publish the selected items as real FMRs.
 *
 * Refuses a batch with unresolved errors: staging exists precisely so bad
 * data is caught before it reaches the ledger.
 */
export async function publishBatch(ctx, { batchId, itemIds }) {
  const { user, projectId } = ctx;

  return withTransaction(async (client) => {
    // An archived batch was deliberately taken out of the queue. Publishing it
    // from a stale screen would put material in front of the crews that
    // somebody had decided against.
    const { rows: batches } = await client.query(
      `SELECT archived, published_at FROM import_batches
        WHERE id = $1 AND project_id = $2`,
      [batchId, projectId]
    );
    if (!batches[0]) throw new LedgerError('That batch was not found.', 'NOT_FOUND');
    if (batches[0].archived) {
      throw new LedgerError(
        'This draft is archived. Restore it before publishing.', 'ARCHIVED'
      );
    }

    const { rows: blocking } = await client.query(
      `SELECT count(*) AS n FROM import_issues
        WHERE batch_id = $1 AND severity = 'error' AND NOT resolved`,
      [batchId]
    );
    if (Number(blocking[0].n) > 0) {
      throw new LedgerError(
        `This batch still has ${blocking[0].n} unresolved error(s). Fix them before publishing.`,
        'HAS_ERRORS'
      );
    }

    const { rows: items } = await client.query(
      `SELECT i.* FROM import_items i
         JOIN import_batches b ON b.id = i.batch_id
        WHERE i.batch_id = $1 AND b.project_id = $2
          AND i.selected AND i.published_fmr_id IS NULL
          ${itemIds?.length ? 'AND i.id = ANY($3::uuid[])' : ''}`,
      itemIds?.length ? [batchId, projectId, itemIds] : [batchId, projectId]
    );

    // Publishing is the field-execution gate, not a status change: it is the
    // moment a crew can be sent looking for this material. So it happens only
    // once the planner has approved the request and the material manager has
    // given it its official number.
    const notReady = items.filter((item) => item.workflow_state !== STATES.NUMBER_ASSIGNED);
    if (notReady.length) {
      const first = notReady[0];
      throw new LedgerError(
        `${first.fmr_number || 'One of these FMRs'} is `
        + `${describeState(first.workflow_state)}. `
        + 'An FMR reaches the field once the planner has approved it and it has been '
        + 'given its number.',
        'NOT_APPROVED'
      );
    }

    const published = [];

    for (const item of items) {
      const { rows: headerRows } = await client.query(
        `INSERT INTO fmr_headers
           (project_id, fmr_number, iwp_number, requested_by, date_required,
            priority, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
         RETURNING id`,
        [
          projectId, item.fmr_number, item.iwp_number, item.requested_by,
          item.date_required, item.priority, user.id
        ]
      );
      const fmrId = headerRows[0].id;

      const { rows: lines } = await client.query(
        `SELECT * FROM import_lines WHERE item_id = $1 ORDER BY line_number`,
        [item.id]
      );

      for (const line of lines) {
        await client.query(
          `INSERT INTO fmr_lines
             (project_id, fmr_id, line_number, iso_number, iso_sheet,
              iso_revision, commodity_code, size, material_description,
              qty_requested, uom, storage_location, created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)`,
          [
            projectId, fmrId, line.line_number, item.iso_number, item.iso_sheet,
            item.iso_revision,
            line.commodity_code, line.size, line.description, line.quantity,
            line.uom, line.storage_location, user.id
          ]
        );
      }

      await client.query(
        `UPDATE import_items
            SET published_fmr_id = $2, status = 'Published',
                workflow_state = $3
          WHERE id = $1`,
        [item.id, fmrId, STATES.PUBLISHED]
      );

      await client.query(
        `INSERT INTO audit_log
           (project_id, entity_type, entity_id, action, payload, user_id,
            user_email, source_interface)
         VALUES ($1,'FMR',$2,'IMPORT_PUBLISHED',$3,$4,$5,'IMPORT')`,
        [projectId, fmrId, { batchId, sheetName: item.sheet_name, lines: lines.length },
         user.id, user.email]
      );

      published.push({ fmrId, fmrNumber: item.fmr_number, lines: lines.length });
    }

    await client.query(
      `UPDATE import_batches SET status = 'Published', published_at = now() WHERE id = $1`,
      [batchId]
    );

    return { published, count: published.length };
  });
}

const serializeIssue = (row) => ({
  id: row.id,
  severity: row.severity,
  code: row.code,
  message: row.message,
  field: row.field_name,
  sourceRow: row.source_row,
  sourceValue: row.source_value,
  resolved: row.resolved
});

const toSnake = (s) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

function parseDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

/**
 * Where a requisition sits, in a sentence.
 *
 * "is draft" reads as a typo; "is still a draft" reads as an answer.
 */
function describeState(state) {
  const said = {
    DRAFT: 'still a draft',
    PENDING_PLANNER_REVIEW: 'still with the planner',
    PLANNER_APPROVED: 'approved but not yet numbered',
    PLANNER_RETURNED: 'been returned for correction',
    PENDING_MATERIAL_MANAGER: 'waiting for its number'
  };
  return said[state] ?? (STATE_LABELS[state] ?? state).toLowerCase();
}

/**
 * Drop a line from a staged FMR before it is published.
 *
 * The extractor reads what is on the drawing, and what is on the drawing is
 * not always what this requisition is for: crews install the pipe and field
 * welds first and come back for valves, bolts and gaskets months later. The
 * office needs to publish the part being worked now and leave the rest.
 *
 * Only unpublished batches, and never the last line — an FMR with no material
 * is not something a crew can be sent to find.
 */
export async function removeStagedLine(ctx, { lineId }) {
  return withTransaction(async (client) => {
    const { rows: found } = await client.query(
      `SELECT l.id, l.item_id, i.fmr_number, i.batch_id
         FROM import_lines l
         JOIN import_items i ON i.id = l.item_id
         JOIN import_batches b ON b.id = i.batch_id
        WHERE l.id = $1 AND b.project_id = $2 AND b.published_at IS NULL
        FOR UPDATE OF l`,
      [lineId, ctx.projectId]
    );

    const line = found[0];
    if (!line) {
      throw new LedgerError('That line is not in an unpublished batch.', 'NOT_FOUND');
    }

    const { rows: counted } = await client.query(
      'SELECT count(*)::int AS n FROM import_lines WHERE item_id = $1',
      [line.item_id]
    );
    if (counted[0].n <= 1) {
      throw new LedgerError(
        'That is the last line on this FMR. Remove the whole FMR instead.',
        'LAST_LINE'
      );
    }

    await client.query('DELETE FROM import_lines WHERE id = $1', [lineId]);

    // Line numbers are what the office reads back to the field, so close the
    // gap rather than leaving the list numbered 1, 2, 4.
    await client.query(
      `WITH renumbered AS (
         SELECT id, row_number() OVER (ORDER BY line_number) AS n
           FROM import_lines WHERE item_id = $1
       )
       UPDATE import_lines l SET line_number = r.n
         FROM renumbered r WHERE r.id = l.id`,
      [line.item_id]
    );

    await client.query(
      `UPDATE import_items SET line_count = (
         SELECT count(*) FROM import_lines WHERE item_id = $1
       ) WHERE id = $1`,
      [line.item_id]
    );

    await client.query(
      `INSERT INTO audit_log
         (project_id, entity_type, entity_id, action, payload, user_id,
          user_email, source_interface)
       VALUES ($1,'DRAFT',$2,'STAGED_LINE_REMOVED',$3,$4,$5,'IMPORT')`,
      [ctx.projectId, line.item_id, { lineId, fmrNumber: line.fmr_number },
       ctx.user.id, ctx.user.email]
    );

    await recountBatch(client, line.batch_id);

    return { ok: true, itemId: line.item_id, remaining: counted[0].n - 1 };
  });
}

/**
 * Drop a whole staged FMR before it is published.
 *
 * A package holds every drawing a planner compiled, and they are often only
 * working part of it. Deselecting hides an FMR from the publish button but
 * leaves it in the queue; this removes it.
 */
export async function removeStagedItem(ctx, { itemId }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT i.id, i.fmr_number, i.batch_id
         FROM import_items i
         JOIN import_batches b ON b.id = i.batch_id
        WHERE i.id = $1 AND b.project_id = $2
          AND b.published_at IS NULL AND i.published_fmr_id IS NULL
        FOR UPDATE OF i`,
      [itemId, ctx.projectId]
    );

    const item = rows[0];
    if (!item) {
      throw new LedgerError(
        'That FMR is not in an unpublished batch, or has already been published.',
        'NOT_FOUND'
      );
    }

    await client.query(
      `INSERT INTO audit_log
         (project_id, entity_type, entity_id, action, payload, user_id,
          user_email, source_interface)
       VALUES ($1,'DRAFT',$2,'STAGED_FMR_REMOVED',$3,$4,$5,'IMPORT')`,
      [ctx.projectId, itemId, { fmrNumber: item.fmr_number },
       ctx.user.id, ctx.user.email]
    );

    // import_lines and import_issues cascade from the item.
    await client.query('DELETE FROM import_items WHERE id = $1', [itemId]);

    await recountBatch(client, item.batch_id);

    return { ok: true, fmrNumber: item.fmr_number };
  });
}
