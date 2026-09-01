/**
 * HTTP API.
 *
 * Deliberately small: node:http plus a route table. The interesting rules all
 * live in the domain layer, and this file's job is only to authenticate the
 * caller, check they may do the thing, and hand off.
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { pool } from '../../core/src/db/pool.js';
import { LedgerError } from '../../core/src/domain/ledger.js';
import { performFieldAction } from '../../core/src/services/field.js';
import {
  getBackorderQueue, decideBackorder
} from '../../core/src/services/backorderReview.js';
import { searchLines, getFmrDetail } from '../../core/src/services/search.js';
import {
  getRegister, getIsoSummary, getLineHistory, getDashboard
} from '../../core/src/services/reporting.js';
import {
  stageWorkbook, getBatch, correctLine, publishBatch
} from '../../import/src/staging.js';
import { outstandingNotices } from '../../core/src/services/notices.js';
import {
  getCorrectableHistory, previewCorrection, applyCorrection, getCorrectionHistory
} from '../../core/src/services/corrections.js';
import {
  getControls, setControls, getHealth, assertImportOpen
} from '../../core/src/services/controls.js';
import {
  inspectIntegrity, repairBackorderTotals
} from '../../core/src/services/integrity.js';
import {
  createDraft, updateDraftHeader, saveDraftLine, deleteDraftLine,
  archiveDraft, restoreDraft, listDrafts, checkDraftForPublish
} from '../../import/src/drafts.js';
import {
  listMembers, saveMember, setMemberActive,
  listValues, saveListValue, setListValueActive, renumberFmr
} from '../../core/src/services/admin.js';
import { getBootstrap } from '../../core/src/services/bootstrap.js';
import { readWorkbook } from '../../import/src/workbook.js';
import { groupExtractedRows, describeExtraction } from '../../import/src/extracted.js';
import { readFile as readProfileFile } from 'node:fs/promises';
import {
  authenticate, require as requirePermission, verifyGoogleToken,
  findUser, recordLogin, issueSession, readSession, membershipsFor, AuthError
} from './auth.js';
import { once, IdempotencyConflict } from './idempotency.js';

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload)
  });
  res.end(payload);
};

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new LedgerError('Request too large.', 'TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new LedgerError('Request body is not valid JSON.', 'BAD_JSON');
  }
}

const routes = [];
const route = (method, pattern, handler) =>
  routes.push({ method, pattern, handler });

// --- sign in ---------------------------------------------------------------

route('POST', /^\/api\/auth\/google$/, async (req, res) => {
  const { idToken } = await readBody(req);
  if (!idToken) throw new AuthError('No sign-in token supplied.', 400);

  const claims = await verifyGoogleToken(idToken);
  const user = await findUser(claims.email);

  // Accounts are provisioned by an admin. An unknown Google account is not
  // an error to explain in detail — just no.
  if (!user) throw new AuthError('This account has not been set up. Ask your administrator.', 403);

  await recordLogin(user.id);
  const token = issueSession(user);
  const projects = await membershipsFor(user.id);

  res.setHeader(
    'set-cookie',
    `fmr_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200`
  );

  json(res, 200, {
    user: { id: user.id, email: user.email, name: user.display_name },
    projects
  });
});

/**
 * Sign in as a seeded user, without Google.
 *
 * Only available when FMR_DEV_LOGIN is set, which no deployment should do.
 * It exists so the system can be run and demonstrated locally before a Google
 * OAuth client has been set up, and it refuses to work unless the environment
 * has explicitly asked for it.
 */
route('POST', /^\/api\/auth\/dev$/, async (req, res) => {
  if (process.env.FMR_DEV_LOGIN !== '1') {
    throw new AuthError('Developer sign-in is not enabled here.', 403);
  }

  const { email } = await readBody(req);
  const user = await findUser(email);
  if (!user) throw new AuthError(`No account for ${email}.`, 403);

  await recordLogin(user.id);
  const token = issueSession(user);

  // No Secure flag: local development is served over http.
  res.setHeader(
    'set-cookie',
    `fmr_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`
  );

  json(res, 200, {
    user: { id: user.id, email: user.email, name: user.display_name },
    projects: await membershipsFor(user.id)
  });
});

/** Who can be signed in as locally, so the page can offer a list. */
route('GET', /^\/api\/auth\/dev$/, async (_req, res) => {
  if (process.env.FMR_DEV_LOGIN !== '1') {
    return json(res, 200, { enabled: false, users: [] });
  }

  const { rows } = await pool.query(
    `SELECT DISTINCT u.email, u.display_name, m.role
       FROM users u
       JOIN project_members m ON m.user_id = u.id
      WHERE u.active
      ORDER BY m.role, u.display_name`
  );

  json(res, 200, {
    enabled: true,
    users: rows.map((r) => ({ email: r.email, name: r.display_name, role: r.role }))
  });
});

route('POST', /^\/api\/auth\/signout$/, async (_req, res) => {
  res.setHeader('set-cookie', 'fmr_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
  json(res, 200, { ok: true });
});

route('GET', /^\/api\/me$/, async (req, res) => {
  const session = readSession(req.headers.cookie);
  if (!session) throw new AuthError('Please sign in.');

  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1 AND active', [session.sub]);
  if (!rows[0]) throw new AuthError('This account is no longer active.');

  json(res, 200, {
    user: { id: rows[0].id, email: rows[0].email, name: rows[0].display_name },
    projects: await membershipsFor(rows[0].id)
  });
});

// --- field -----------------------------------------------------------------

route('GET', /^\/api\/search$/, async (req, res, { url }) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'search');

  const client = await pool.connect();
  try {
    const result = await searchLines(client, ctx.projectId, {
      query: url.searchParams.get('q'),
      mode: (url.searchParams.get('mode') || 'AUTO').toUpperCase(),
      limit: Math.min(Number(url.searchParams.get('limit')) || 200, 500)
    });
    json(res, 200, result);
  } finally {
    client.release();
  }
});

route('GET', /^\/api\/fmr\/([0-9a-f-]{36})$/, async (req, res, { match }) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'search');

  const client = await pool.connect();
  try {
    const detail = await getFmrDetail(client, ctx.projectId, match[1]);
    if (!detail) return json(res, 404, { error: 'FMR not found.' });
    json(res, 200, detail);
  } finally {
    client.release();
  }
});

route('POST', /^\/api\/field\/action$/, async (req, res) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'fieldTransact');

  const body = await readBody(req);
  const result = await once(
    req.headers['idempotency-key'],
    ctx.user,
    body,
    () => performFieldAction(ctx, body)
  );

  json(res, 200, result);
});

// --- admin -----------------------------------------------------------------

route('GET', /^\/api\/backorders$/, async (req, res, { url }) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'adminBackorder');

  const client = await pool.connect();
  try {
    const queue = await getBackorderQueue(client, ctx.projectId, {
      status: url.searchParams.get('status') || undefined
    });
    json(res, 200, { requests: queue });
  } finally {
    client.release();
  }
});

route('POST', /^\/api\/backorders\/decide$/, async (req, res) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'adminBackorder');

  const body = await readBody(req);
  const result = await once(
    req.headers['idempotency-key'],
    ctx.user,
    body,
    () => decideBackorder(ctx, body)
  );

  json(res, 200, result);
});

// --- reporting -------------------------------------------------------------

/** Run a read-only handler with a pooled client, always released. */
async function withClient(ctx, handler, res) {
  const client = await pool.connect();
  try {
    json(res, 200, await handler(client));
  } finally {
    client.release();
  }
}

route('GET', /^\/api\/register$/, async (req, res, { url }) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'search');
  await withClient(ctx, (c) => getRegister(c, ctx.projectId, {
    status: url.searchParams.get('status') || undefined,
    priority: url.searchParams.get('priority') || undefined
  }), res);
});

route('GET', /^\/api\/iso-summary$/, async (req, res) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'search');
  await withClient(ctx, (c) => getIsoSummary(c, ctx.projectId), res);
});

route('GET', /^\/api\/dashboard$/, async (req, res) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'search');
  await withClient(ctx, (c) => getDashboard(c, ctx.projectId), res);
});

route('GET', /^\/api\/lines\/([0-9a-f-]{36})\/history$/, async (req, res, { match }) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'search');
  await withClient(ctx, async (c) => ({
    history: await getLineHistory(c, ctx.projectId, match[1])
  }), res);
});

// --- import ----------------------------------------------------------------

/** Load a project's extraction profile, falling back to the baseline. */
async function loadProfile(name) {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '../../import/profiles');
  const safe = String(name ?? 'default').replace(/[^a-z0-9_-]/gi, '');

  try {
    return JSON.parse(await readProfileFile(join(dir, `${safe}.json`), 'utf8'));
  } catch {
    return JSON.parse(await readProfileFile(join(dir, 'default.json'), 'utf8'));
  }
}

/** Parse an uploaded workbook and stage it for review. Publishes nothing. */
route('POST', /^\/api\/import\/stage$/, async (req, res, { url }) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'ownerEdit');

  const filename = url.searchParams.get('filename') ?? 'upload.xlsx';
  const profileName = url.searchParams.get('profile') ?? 'default';

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 25_000_000) throw new LedgerError('That file is too large.', 'TOO_LARGE');
    chunks.push(chunk);
  }
  if (!size) throw new LedgerError('No file was uploaded.', 'NO_FILE');

  const client = await pool.connect();
  try {
    await assertImportOpen(client, ctx.projectId);
  } finally {
    client.release();
  }

  const profile = await loadProfile(profileName);
  const sheets = readWorkbook(Buffer.concat(chunks), filename);

  const result = await stageWorkbook(ctx, {
    sheets, sourceName: filename, profile, profileName
  });

  json(res, 200, result);
});

/**
 * Stage the output of a drawing extraction run.
 *
 * extract_materials.py reads material off ISO drawing PDFs; this takes its CSV
 * and turns it into one draft FMR per drawing. Nothing is published — the
 * drafts queue is where a person checks the extractor's work.
 */
route('POST', /^\/api\/import\/extracted$/, async (req, res, { url }) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'ownerEdit');

  const client = await pool.connect();
  try {
    await assertImportOpen(client, ctx.projectId);
  } finally {
    client.release();
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 25_000_000) throw new LedgerError('That file is too large.', 'TOO_LARGE');
    chunks.push(chunk);
  }
  if (!size) throw new LedgerError('No file was uploaded.', 'NO_FILE');

  const minConfidence = Number(url.searchParams.get('minConfidence')) || 0;
  const { sheets, summary } = groupExtractedRows(
    Buffer.concat(chunks).toString('utf8'),
    { minConfidence }
  );

  if (!sheets.length) {
    throw new LedgerError('No drawings were found in that file.', 'NO_DRAWINGS');
  }

  const result = await stageWorkbook(ctx, {
    sheets: sheets.map((s) => ({ name: s.sheetName, grid: [] })),
    sourceName: url.searchParams.get('filename') ?? 'extraction.csv',
    profile: { header: {}, columns: {} },
    profileName: 'extracted',
    preExtracted: sheets
  });

  json(res, 200, { ...result, summary, description: describeExtraction(summary) });
});

route('GET', /^\/api\/import\/([0-9a-f-]{36})$/, async (req, res, { match }) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'ownerEdit');

  const client = await pool.connect();
  try {
    const batch = await getBatch(client, ctx.projectId, match[1]);
    if (!batch) return json(res, 404, { error: 'Import batch not found.' });
    json(res, 200, batch);
  } finally {
    client.release();
  }
});

route('POST', /^\/api\/import\/line$/, async (req, res) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'ownerEdit');

  const body = await readBody(req);
  json(res, 200, { line: await correctLine(ctx, body) });
});

route('POST', /^\/api\/import\/publish$/, async (req, res) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'ownerEdit');

  const body = await readBody(req);
  const result = await once(
    req.headers['idempotency-key'],
    ctx.user,
    body,
    () => publishBatch(ctx, body)
  );

  json(res, 200, result);
});

// --- notices ---------------------------------------------------------------

route('GET', /^\/api\/notices$/, async (req, res) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'search');
  await withClient(ctx, async (c) => ({
    notices: await outstandingNotices(c, ctx.projectId)
  }), res);
});

// --- corrections -----------------------------------------------------------

route('GET', /^\/api\/lines\/([0-9a-f-]{36})\/corrections$/, async (req, res, { match }) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'ownerEdit');
  await withClient(ctx, async (c) => ({
    groups: await getCorrectableHistory(c, ctx.projectId, match[1])
  }), res);
});

/** Show what a correction would do. Writes nothing. */
route('POST', /^\/api\/corrections\/preview$/, async (req, res) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'ownerEdit');
  json(res, 200, await previewCorrection(ctx, await readBody(req)));
});

route('POST', /^\/api\/corrections\/apply$/, async (req, res) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'ownerEdit');

  const body = await readBody(req);
  const result = await once(
    req.headers['idempotency-key'],
    ctx.user,
    body,
    () => applyCorrection(ctx, body)
  );
  json(res, 200, result);
});

route('GET', /^\/api\/corrections$/, async (req, res) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'ownerEdit');
  await withClient(ctx, async (c) => ({
    corrections: await getCorrectionHistory(c, ctx.projectId)
  }), res);
});

// --- controls --------------------------------------------------------------

route('GET', /^\/api\/controls$/, async (req, res) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'search');
  await withClient(ctx, (c) => getControls(c, ctx.projectId), res);
});

route('POST', /^\/api\/controls$/, async (req, res) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'ownerEdit');
  json(res, 200, await setControls(ctx, await readBody(req)));
});

route('GET', /^\/api\/project-health$/, async (req, res) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'search');
  await withClient(ctx, (c) => getHealth(c, ctx.projectId), res);
});

// --- drafts ----------------------------------------------------------------
//
// A hand-written FMR. Goes through the same review and publish path as an
// imported one — see packages/import/src/drafts.js.

route('GET', /^\/api\/drafts$/, async (req, res, { url }) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'ownerEdit');
  await withClient(ctx, (c) => listDrafts(c, ctx.projectId, {
    source: url.searchParams.get('source') || undefined,
    includeArchived: url.searchParams.get('archived') !== 'false'
  }), res);
});

route('POST', /^\/api\/drafts$/, async (req, res) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'ownerEdit');

  const body = await readBody(req);
  const result = await once(
    req.headers['idempotency-key'], ctx.user, body,
    () => createDraft(ctx, body)
  );
  json(res, 200, result);
});

route('POST', /^\/api\/drafts\/header$/, async (req, res) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'ownerEdit');
  json(res, 200, await updateDraftHeader(ctx, await readBody(req)));
});

route('POST', /^\/api\/drafts\/line$/, async (req, res) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'ownerEdit');
  json(res, 200, await saveDraftLine(ctx, await readBody(req)));
});

route('DELETE', /^\/api\/drafts\/line$/, async (req, res) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'ownerEdit');
  json(res, 200, await deleteDraftLine(ctx, await readBody(req)));
});

route('POST', /^\/api\/drafts\/archive$/, async (req, res) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'ownerEdit');

  const body = await readBody(req);
  json(res, 200, body.restore
    ? await restoreDraft(ctx, body)
    : await archiveDraft(ctx, body));
});

/** Re-validate the way publishing will, so the button reflects the real rules. */
route('GET', /^\/api\/drafts\/([0-9a-f-]{36})\/check$/, async (req, res, { match }) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'ownerEdit');
  await withClient(ctx, (c) => checkDraftForPublish(c, ctx.projectId, match[1]), res);
});

// --- bootstrap -------------------------------------------------------------

/** What the field screen needs on start: dropdown values and limits. */
route('GET', /^\/api\/bootstrap$/, async (req, res) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'search');
  await withClient(ctx, (c) => getBootstrap(c, ctx.projectId, ctx), res);
});

// --- administration --------------------------------------------------------

route('GET', /^\/api\/admin\/members$/, async (req, res) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'ownerEdit');
  await withClient(ctx, (c) => listMembers(c, ctx.projectId), res);
});

route('POST', /^\/api\/admin\/members$/, async (req, res) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'ownerEdit');
  json(res, 200, await saveMember(ctx, await readBody(req)));
});

route('POST', /^\/api\/admin\/members\/active$/, async (req, res) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'ownerEdit');
  json(res, 200, await setMemberActive(ctx, await readBody(req)));
});

route('GET', /^\/api\/admin\/lists$/, async (req, res, { url }) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'ownerEdit');
  await withClient(ctx, async (c) => ({
    lists: await listValues(c, ctx.projectId, url.searchParams.get('name') || undefined)
  }), res);
});

route('POST', /^\/api\/admin\/lists$/, async (req, res) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'ownerEdit');

  const body = await readBody(req);
  json(res, 200, body.setActive !== undefined
    ? await setListValueActive(ctx, { id: body.id, active: body.setActive })
    : await saveListValue(ctx, body));
});

route('POST', /^\/api\/fmr\/renumber$/, async (req, res) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'ownerEdit');

  const body = await readBody(req);
  const result = await once(
    req.headers['idempotency-key'], ctx.user, body,
    () => renumberFmr(ctx, body)
  );
  json(res, 200, result);
});

// --- integrity -------------------------------------------------------------

/** Read-only. Reports what is inconsistent across rows; changes nothing. */
route('GET', /^\/api\/integrity$/, async (req, res) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'ownerEdit');
  await withClient(ctx, (c) => inspectIntegrity(c, ctx.projectId), res);
});

/**
 * Bring line backorder totals back into line with their requests.
 * The requests are the record of what was asked and decided, so they win.
 */
route('POST', /^\/api\/integrity\/repair$/, async (req, res) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'ownerEdit');

  const body = await readBody(req);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await repairBackorderTotals({ ...ctx, client }, body);
    await client.query('COMMIT');
    json(res, 200, result);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

route('GET', /^\/api\/health$/, async (_req, res) => {
  await pool.query('SELECT 1');
  json(res, 200, { ok: true });
});

// --- dispatch --------------------------------------------------------------

// --- static files ----------------------------------------------------------

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '../../web/public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

async function serveStatic(pathname, res) {
  // normalize() collapses any ../ before it can escape the web root.
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  const file = join(webRoot, rel);
  if (!file.startsWith(webRoot)) return false;

  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache'
    });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
    if (await serveStatic(url.pathname, res)) return;
  }

  const matched = routes
    .map((r) => ({ ...r, match: url.pathname.match(r.pattern) }))
    .find((r) => r.match && r.method === req.method);

  if (!matched) return json(res, 404, { error: 'Not found.' });

  try {
    await matched.handler(req, res, { url, match: matched.match });
  } catch (error) {
    if (error instanceof AuthError) {
      return json(res, error.status, { error: error.message });
    }
    if (error instanceof IdempotencyConflict) {
      return json(res, error.status, { error: error.message });
    }
    if (error instanceof LedgerError) {
      // A rule was broken — the crew needs to know which, in their words.
      return json(res, 422, { error: error.message, code: error.code });
    }

    console.error(error);
    json(res, 500, { error: 'Something went wrong. Try again.' });
  }
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => console.log(`fmr api listening on ${port}`));
