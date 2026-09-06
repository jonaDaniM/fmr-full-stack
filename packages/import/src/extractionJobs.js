/**
 * The lifecycle of one drawing-extraction run.
 *
 * Reading a package takes longer than a request should wait, so a job is
 * recorded, the request answers with its id, and the work carries on in the
 * background. The browser polls until the job says it is done and names the
 * batch to review.
 *
 * The job row is the only thing the person waiting can see, so every path out
 * of here ends by writing one — a run that throws must not leave a job saying
 * "Running" forever.
 */

import { pool } from '../../core/src/db/pool.js';
import { LedgerError } from '../../core/src/domain/ledger.js';
import { extractDrawings } from './runner.js';
import { toDraftSheets, describePackage } from './drawings.js';
import { stageWorkbook } from './staging.js';
import { download, discard } from './objectStore.js';

/** Claim the one running slot this project has. */
export async function startJob(ctx, { sourceName, fileCount, iwpNumber }) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO extraction_jobs
         (project_id, created_by, source_name, file_count, iwp_number)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [ctx.projectId, ctx.user.id, sourceName, fileCount, iwpNumber || null]
    );
    return rows[0].id;
  } catch (error) {
    // The partial unique index refuses a second running job on the project.
    if (error.constraint === 'extraction_jobs_one_running') {
      throw new LedgerError(
        'Drawings are already being read for this project. Wait for that to finish.',
        'EXTRACT_BUSY'
      );
    }
    throw error;
  }
}

async function finish(jobId, { status, batchId = null, message = null }) {
  await pool.query(
    `UPDATE extraction_jobs
        SET status = $2, batch_id = $3, message = $4, finished_at = now()
      WHERE id = $1`,
    [jobId, status, batchId, message]
  );
}

/**
 * Read the package and stage it, then record how it went.
 *
 * Never rejects: it is started without being awaited, and an unhandled
 * rejection would take the server down rather than telling anyone.
 */
export async function runJob(ctx, jobId, files, { iwpNumber, sourceName, objects = null }) {
  try {
    // A package too big to send through the app was uploaded straight to Cloud
    // Storage; the bytes are fetched here rather than in the request, so the
    // download happens on the job's time and not the browser's.
    const drawings = files ?? await Promise.all(objects.map(download));

    const payload = await extractDrawings(drawings, { iwpNumber });
    const { sheets, summary } = toDraftSheets(payload);

    if (!sheets.length) {
      // The package was read; nothing in it was an isometric this can stage.
      // Saying only "no drawings were found" of a file that plainly holds
      // drawings reads as a broken parser, so say what it did find instead:
      // a weld log and a cover sheet is a different problem from a scan that
      // needs OCR, and only one of them is worth re-exporting.
      const { quarantined, droppedRows, pdfsDiscovered } = summary;
      const because = [
        quarantined && `${quarantined} page${quarantined === 1 ? ' was' : 's were'} set aside `
          + '(weld logs, covers, or scans with no text behind them)',
        droppedRows && `${droppedRows} drawing${droppedRows === 1 ? '' : 's'} had no `
          + 'readable drawing number'
      ].filter(Boolean);

      throw new LedgerError(
        `No isometric drawings could be read from `
        + `${pdfsDiscovered || 'those'} file${pdfsDiscovered === 1 ? '' : 's'}.`
        + (because.length ? ` ${because.join(', and ')}.` : '')
        + ' A package of weld logs or scanned sheets has nothing to stage —'
        + ' check this is the drawing package, or upload the sheets on their own.',
        'NO_DRAWINGS'
      );
    }

    const result = await stageWorkbook(ctx, {
      sheets: sheets.map((s) => ({ name: s.sheetName, grid: [] })),
      sourceName,
      profile: { header: {}, columns: {} },
      profileName: 'drawings',
      preExtracted: sheets
    });

    await finish(jobId, {
      status: 'Done',
      batchId: result.batchId,
      message: describePackage(summary)
    });
  } catch (error) {
    // A LedgerError was written for the person waiting. Anything else was not,
    // so it is logged and they are told something they can act on instead.
    const readable = error instanceof LedgerError
      ? error.message
      : 'Those drawings could not be read. Try again, or send a smaller package.';

    if (!(error instanceof LedgerError)) console.error('extraction job failed:', error);

    await finish(jobId, { status: 'Failed', message: readable })
      .catch((cause) => console.error('could not record the failed job:', cause));
  } finally {
    // The uploads are the client's drawings. They have been read into the
    // batch by now, or the read failed and they are no use to anyone — either
    // way they do not stay in the bucket. `discard` never throws.
    if (objects) await Promise.all(objects.map(discard));
  }
}

/** What to tell the browser that is waiting. */
export async function getJob(projectId, jobId) {
  const { rows } = await pool.query(
    `SELECT id, status, batch_id, message, file_count, created_at, finished_at
       FROM extraction_jobs
      WHERE id = $1 AND project_id = $2`,
    [jobId, projectId]
  );

  const job = rows[0];
  if (!job) throw new LedgerError('That extraction was not found.', 'NOT_FOUND');

  return {
    jobId: job.id,
    status: job.status,
    batchId: job.batch_id,
    message: job.message,
    fileCount: job.file_count,
    startedAt: job.created_at,
    finishedAt: job.finished_at
  };
}

/**
 * Close out jobs a restart abandoned.
 *
 * The work lived in one process; if that process is gone the job is not coming
 * back, and a browser polling it would wait forever. Called once on boot.
 */
export async function failAbandonedJobs() {
  const { rowCount } = await pool.query(
    `UPDATE extraction_jobs
        SET status = 'Failed', finished_at = now(),
            message = 'The server restarted while these drawings were being read. Try again.'
      WHERE status = 'Running'`
  );
  if (rowCount) console.log(`marked ${rowCount} abandoned extraction job(s) failed`);
  return rowCount;
}
