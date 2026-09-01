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
export async function stageWorkbook(ctx, { sheets, sourceName, profile, profileName }) {
  const { user, projectId } = ctx;
  const extraction = extractWorkbook(sheets, profile);

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
      if (sheet.header.fmrNumber) {
        const { rows } = await client.query(
          `SELECT id FROM fmr_headers WHERE project_id = $1 AND fmr_number = $2`,
          [projectId, sheet.header.fmrNumber]
        );
        existingFmrId = rows[0]?.id ?? null;
      }

      const { rows: itemRows } = await client.query(
        `INSERT INTO import_items
           (batch_id, project_id, sheet_name, fmr_number, iwp_number, iso_number,
            iso_sheet, requested_by, date_required, priority, header_json,
            line_count, status, selected, existing_fmr_id)
         VALUES ($1,$15,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING id`,
        [
          batchId, sheet.sheetName, sheet.header.fmrNumber ?? null,
          sheet.header.iwpNumber ?? null, sheet.header.isoNumber ?? null,
          sheet.header.isoSheet ?? null, sheet.header.requestedBy ?? null,
          parseDate(sheet.header.dateRequired), sheet.header.priority ?? null,
          sheet.header, sheet.lines.length,
          hasErrors ? 'Blocked' : existingFmrId ? 'Duplicate' : 'Ready',
          !hasErrors && !existingFmrId,
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
            batchId, itemId, sheet.sheetName, issue.severity, issue.code,
            issue.message, issue.field ?? null, issue.row ?? null,
            issue.value ?? null
          ]
        );
      }
    }

    return { batchId, summary: extraction.summary };
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
