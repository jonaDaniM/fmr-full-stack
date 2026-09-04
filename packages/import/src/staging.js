/**
 * Import staging.
 *
 * A parsed workbook becomes a batch that someone reviews before any of it
 * becomes a real FMR. Nothing here writes to fmr_headers or fmr_lines until
 * publish is called, and publish refuses a batch that still has errors.
 */

import { withTransaction } from '../../core/src/db/pool.js';
import { extractWorkbook, SEVERITY } from './extract.js';
import { LedgerError } from '../../core/src/domain/ledger.js';

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
            iso_sheet, requested_by, date_required, priority, header_json,
            line_count, status, selected, existing_fmr_id)
         VALUES ($1,$15,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING id`,
        [
          batchId, sheet.sheetName, fmrNumber,
          sheet.header.iwpNumber ?? null, sheet.header.isoNumber ?? null,
          sheet.header.isoSheet ?? null, sheet.header.requestedBy ?? null,
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
        uomRule: l.uom_rule
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
    return rows[0];
  });
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
              commodity_code, size, material_description, qty_requested, uom,
              storage_location, created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
          [
            projectId, fmrId, line.line_number, item.iso_number, item.iso_sheet,
            line.commodity_code, line.size, line.description, line.quantity,
            line.uom, line.storage_location, user.id
          ]
        );
      }

      await client.query(
        `UPDATE import_items SET published_fmr_id = $2, status = 'Published' WHERE id = $1`,
        [item.id, fmrId]
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
      `SELECT l.id, l.item_id, i.fmr_number
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

    return { ok: true, fmrNumber: item.fmr_number };
  });
}
