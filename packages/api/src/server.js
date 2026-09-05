/**
 * HTTP API.
 *
 * Deliberately small: node:http plus a route table. The interesting rules all
 * live in the domain layer, and this file's job is only to authenticate the
 * caller, check they may do the thing, and hand off.
 */

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
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
  getRegister, getIsoSummary, getLineHistory, getDashboard, getActiveBagQueue
} from '../../core/src/services/reporting.js';
import {
  stageWorkbook, getBatch, correctLine, publishBatch,
  removeStagedLine, removeStagedItem
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
import { readWorkbook, WorkbookError } from '../../import/src/workbook.js';
import { groupExtractedRows, describeExtraction } from '../../import/src/extracted.js';
import { extractDrawings } from '../../import/src/runner.js';
import { advance, assignNumber, reviewQueue } from '../../import/src/workflow.js';
import { takeoffDocument, takeoffFilename } from '../../import/src/mto.js';
import {
  startJob, runJob, getJob, failAbandonedJobs
} from '../../import/src/extractionJobs.js';
import { readFile as readProfileFile } from 'node:fs/promises';
import {
  authenticate, require as requirePermission, verifyGoogleToken,
  findUser, recordLogin, issueSession, readSession, membershipsFor,
  revokeSession, auditAuth, AuthError
} from './auth.js';
import { once, IdempotencyConflict, IdempotencyInFlight } from './idempotency.js';
import { createRateLimiter, callerAddress } from './rateLimit.js';

/**
 * Headers on everything this server sends.
 *
 * The pages build HTML by concatenation, so escaping is what stands between a
 * material description and an injected script. `script-src 'self'` is the
 * second line: even if something slipped through, an inline script would not
 * run. It also means no page may carry an inline <script> or an onclick
 * attribute of its own — all behaviour lives in a .js file.
 *
 * accounts.google.com is admitted because Google Identity Services renders the
 * real sign-in button; nothing else off-origin executes.
 */
const SECURITY_HEADERS = {
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self' https://accounts.google.com",
    // 'unsafe-inline' covers style attributes only — progress bars and
    // fulfilment bars set their width inline. It does not admit inline
    // script, which is the direction an injection would need to go.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' data:",
    "connect-src 'self'",
    'frame-src https://accounts.google.com',
    // The office screens confirm and reject backorders on a single click, so
    // they must not be framable.
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'"
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin-allow-popups'
};

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
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

const signInLimiter = createRateLimiter();

route('POST', /^\/api\/auth\/google$/, async (req, res) => {
  const ip = callerAddress(req);

  if (signInLimiter.exceeded(req)) {
    await auditAuth('SIGNIN_THROTTLED', { email: null, reason: 'rate limit', ip });
    throw new AuthError('Too many sign-in attempts. Wait a few minutes and try again.', 429);
  }

  const { idToken } = await readBody(req);
  if (!idToken) throw new AuthError('No sign-in token supplied.', 400);

  let claims;
  try {
    claims = await verifyGoogleToken(idToken);
  } catch (error) {
    // The token itself did not check out. Whose it was is not knowable here,
    // which is worth recording as its own kind of refusal.
    await auditAuth('SIGNIN_REFUSED', { email: null, reason: error.message, ip });
    throw error;
  }

  const user = await findUser(claims.email);

  // Accounts are provisioned by an admin. An unknown Google account is not
  // an error to explain in detail — just no.
  if (!user) {
    await auditAuth('SIGNIN_REFUSED', {
      email: claims.email, reason: 'no account for this address', ip
    });
    throw new AuthError('This account has not been set up. Ask your administrator.', 403);
  }

  await recordLogin(user.id);
  await auditAuth('SIGNIN', { email: user.email, userId: user.id, ip });
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
  if (!user) {
    await auditAuth('SIGNIN_REFUSED', {
      email, reason: 'no account for this address', ip: callerAddress(req)
    });
    throw new AuthError(`No account for ${email}.`, 403);
  }

  await recordLogin(user.id);
  await auditAuth('SIGNIN', {
    email: user.email, userId: user.id, reason: 'developer sign-in',
    ip: callerAddress(req)
  });
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

/**
 * What sign-in methods this server offers, and who can be signed in as
 * locally.
 *
 * `googleClientId` is a public value by design — Google Identity Services
 * needs it in the browser to render its button, and it grants nothing on its
 * own. Without it the sign-in page can say so plainly instead of offering a
 * button that cannot work.
 */
route('GET', /^\/api\/auth\/dev$/, async (_req, res) => {
  const googleClientId = process.env.GOOGLE_CLIENT_ID ?? null;

  if (process.env.FMR_DEV_LOGIN !== '1') {
    return json(res, 200, { enabled: false, users: [], googleClientId });
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
    googleClientId,
    users: rows.map((r) => ({ email: r.email, name: r.display_name, role: r.role }))
  });
});

route('POST', /^\/api\/auth\/signout$/, async (req, res) => {
  // Clearing the cookie persuades this browser to forget the token. Revoking
  // the session is what stops a copy of it being used somewhere else.
  const session = readSession(req.headers.cookie);
  await revokeSession(session);

  if (session) {
    await auditAuth('SIGNOUT', {
      email: session.email, userId: session.sub, ip: callerAddress(req)
    });
  }

  res.setHeader('set-cookie', 'fmr_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
  json(res, 200, { ok: true });
});

route('GET', /^\/api\/me$/, async (req, res) => {
  const session = readSession(req.headers.cookie);
  if (!session) throw new AuthError('Please sign in.');

  // Checked here as well as in authenticate(): this route is what the shell
  // asks on load, so a revoked session must not paint a signed-in topbar.
  const { rows } = await pool.query(
    `SELECT u.*, EXISTS (SELECT 1 FROM revoked_sessions r WHERE r.sid = $2) AS revoked
       FROM users u WHERE u.id = $1 AND u.active`,
    [session.sub, session.sid ?? null]
  );
  if (rows[0]?.revoked) throw new AuthError('You have been signed out. Please sign in again.');

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
      status: url.searchParams.get('status') || undefined,
      page: Number(url.searchParams.get('page')) || 1,
      pageSize: Number(url.searchParams.get('pageSize')) || undefined
    });
    json(res, 200, queue);
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
    priority: url.searchParams.get('priority') || undefined,
    query: url.searchParams.get('q') || undefined,
    queryType: url.searchParams.get('type') || undefined,
    exception: url.searchParams.get('exception') || undefined,
    sort: url.searchParams.get('sort') || undefined,
    direction: url.searchParams.get('direction') || undefined,
    page: Number(url.searchParams.get('page')) || 1,
    pageSize: Number(url.searchParams.get('pageSize')) || undefined
  }), res);
});

route('GET', /^\/api\/iso-summary$/, async (req, res, { url }) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'search');
  await withClient(ctx, (c) => getIsoSummary(c, ctx.projectId, {
    query: url.searchParams.get('q') || undefined,
    page: Number(url.searchParams.get('page')) || 1,
    pageSize: Number(url.searchParams.get('pageSize')) || undefined
  }), res);
});

route('GET', /^\/api\/dashboard$/, async (req, res) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'search');
  await withClient(ctx, (c) => getDashboard(c, ctx.projectId), res);
});

/**
 * Bags still holding material.
 *
 * Beside the backorder queue on the Office screen: a backorder is material the
 * office owes the field, an unissued bag is material the field is owed and
 * cannot see. Same permission as the backorder queue — it is the same job.
 */
route('GET', /^\/api\/active-bags$/, async (req, res, { url }) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'adminBackorder');
  await withClient(ctx, (c) => getActiveBagQueue(c, ctx.projectId, {
    query: url.searchParams.get('q') || undefined,
    readiness: url.searchParams.get('readiness') || undefined,
    sortOrder: url.searchParams.get('sort') || undefined,
    page: Number(url.searchParams.get('page')) || 1,
    pageSize: Number(url.searchParams.get('pageSize')) || 25
  }), res);
});

route('GET', /^\/api\/lines\/([0-9a-f-]{36})\/history$/, async (req, res, { match }) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'search');
  await withClient(ctx, async (c) => ({
    history: await getLineHistory(c, ctx.projectId, match[1])
  }), res);
});

// --- import ----------------------------------------------------------------

/**
 * Pull several uploaded files out of one body.
 *
 * There is no multipart parser here and adding one would mean a dependency, so
 * a package is sent as its files laid end to end, each preceded by a header
 * naming its length and filename:
 *
 *     <name length: 4 bytes BE><data length: 4 bytes BE><name><data>
 *
 * Anything malformed is refused outright rather than read as far as it parses
 * — a truncated upload is not a smaller package.
 */
function unframeFiles(body) {
  const files = [];
  let at = 0;

  while (at < body.length) {
    if (at + 8 > body.length) throw new LedgerError('That upload was incomplete.', 'BAD_UPLOAD');

    const nameLength = body.readUInt32BE(at);
    const dataLength = body.readUInt32BE(at + 4);
    at += 8;

    // A length that runs past the end means the body was cut short or is not
    // in this format at all.
    if (nameLength > 1024 || at + nameLength + dataLength > body.length) {
      throw new LedgerError('That upload was incomplete.', 'BAD_UPLOAD');
    }

    const name = body.subarray(at, at + nameLength).toString('utf8');
    at += nameLength;
    files.push({ name, data: body.subarray(at, at + dataLength) });
    at += dataLength;
  }

  return files;
}

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

/**
 * Read a package of drawing PDFs and stage what it holds.
 *
 * The files arrive as one body, each framed by its length, because there is no
 * multipart parser here and a package is several drawings at once. Reading
 * them takes longer than a request should be held open, so the work is
 * recorded and started, and the browser is given a job to poll.
 */
route('POST', /^\/api\/import\/drawings$/, async (req, res, { url }) => {
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
    // A package of drawings is bigger than a workbook: 20 real ISO sheets run
    // to about 10 MB, and packages vary.
    if (size > 100_000_000) {
      throw new LedgerError('That package is too large.', 'TOO_LARGE');
    }
    chunks.push(chunk);
  }
  if (!size) throw new LedgerError('No drawings were uploaded.', 'NO_FILE');

  const files = unframeFiles(Buffer.concat(chunks));
  if (!files.length) throw new LedgerError('No drawings were uploaded.', 'NO_FILE');

  const iwpNumber = (url.searchParams.get('iwp') ?? '').trim();
  const sourceName = url.searchParams.get('filename')
    ?? `${files.length} drawing${files.length === 1 ? '' : 's'}`;

  const jobId = await startJob(ctx, {
    sourceName, fileCount: files.length, iwpNumber
  });

  // Deliberately not awaited: the answer is the job id, and the reading
  // carries on behind it. runJob records its own failures and never rejects.
  runJob(ctx, jobId, files, { iwpNumber, sourceName });

  json(res, 202, { jobId, fileCount: files.length });
});

/**
 * Record that material was taken off for quoting.
 *
 * Nothing is staged, so there is no entity to hang this on — but "who took
 * this off, and when" is the question asked six weeks later when an order
 * does not match the package, and the answer has to exist somewhere.
 */
async function auditTakeoff(ctx, takeoff, filename) {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO audit_log
         (project_id, entity_type, entity_id, action, payload, user_id,
          user_email, source_interface)
       VALUES ($1,'TAKEOFF',$2,'TAKEOFF_GENERATED',$3,$4,$5,'IMPORT')`,
      [
        ctx.projectId,
        // entity_id is NOT NULL and nothing was staged, so the package this
        // came off is the thing being recorded.
        takeoff.iwpNumber || filename,
        {
          filename,
          iwpNumber: takeoff.iwpNumber || null,
          cwa: takeoff.cwa || null,
          drawings: takeoff.drawings,
          rows: takeoff.rows.length,
          missingPipeSpec: takeoff.missingPipeSpec
        },
        ctx.user.id, ctx.user.email
      ]
    );
  } finally {
    client.release();
  }
}

/**
 * Read a package and answer with its Material Takeoff.
 *
 * The first document of a project, and the one the material team buys from:
 * planners get the drawings, an MTO goes out to be quoted, material is
 * ordered, and only then is there anything for an FMR to requisition.
 *
 * Synchronous, unlike the FMR import. Nothing is staged and nothing is
 * written — the answer is a file, so there is no job to poll.
 */
route('POST', /^\/api\/import\/takeoff$/, async (req, res, { url }) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'ownerEdit');

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 100_000_000) {
      throw new LedgerError('That package is too large.', 'TOO_LARGE');
    }
    chunks.push(chunk);
  }
  if (!size) throw new LedgerError('No drawings were uploaded.', 'NO_FILE');

  const files = unframeFiles(Buffer.concat(chunks));
  if (!files.length) throw new LedgerError('No drawings were uploaded.', 'NO_FILE');

  const takeoff = await extractDrawings(files, {
    iwpNumber: (url.searchParams.get('iwp') ?? '').trim() || undefined,
    cwa: (url.searchParams.get('cwa') ?? '').trim() || null,
    takeoff: true
  });

  const document = takeoffDocument(takeoff);
  const filename = takeoffFilename(takeoff);

  // Reading a package is not a change to anything, but who took material off
  // for quoting is worth knowing when the order is questioned later.
  await auditTakeoff(ctx, takeoff, filename);

  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${filename}"`,
    'content-length': Buffer.byteLength(document),
    'x-takeoff-rows': String(takeoff.rows.length),
    'x-takeoff-drawings': String(takeoff.drawings)
  });
  res.end(document);
});

// --- the approval chain ----------------------------------------------------
//
// An FMR reaches a crew once a planner has approved it and the material
// manager has given it its official number. These are the moves between.

/** What is waiting on whoever is asking. */
route('GET', /^\/api\/review$/, async (req, res, { url }) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'search');
  await withClient(ctx, (c) => reviewQueue(c, ctx, {
    state: url.searchParams.get('state') || null
  }), res);
});

/** Submit, approve, return, or send on. The domain decides who may. */
route('POST', /^\/api\/review\/advance$/, async (req, res) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'search');

  const body = await readBody(req);
  json(res, 200, await advance(ctx, body));
});

/**
 * Give an FMR its official number.
 *
 * Its own route because it is its own decision, owned by material control —
 * not a header field anyone editing a draft can change.
 */
route('POST', /^\/api\/review\/number$/, async (req, res) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'search');

  const body = await readBody(req);
  json(res, 200, await assignNumber(ctx, body));
});

/** How a package being read is getting on. */
route('GET', /^\/api\/import\/jobs\/([0-9a-f-]{36})$/, async (req, res, { match }) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'ownerEdit');
  json(res, 200, await getJob(ctx.projectId, match[1]));
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

route('DELETE', /^\/api\/import\/line$/, async (req, res) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'ownerEdit');

  const body = await readBody(req);
  json(res, 200, await removeStagedLine(ctx, body));
});

// A planner often works part of a package. Removing one proposed FMR is not
// the same as deselecting it: deselecting leaves it in the queue.
route('DELETE', /^\/api\/import\/item$/, async (req, res) => {
  const ctx = await authenticate(req);
  requirePermission(ctx, 'ownerEdit');

  const body = await readBody(req);
  json(res, 200, await removeStagedItem(ctx, body));
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

/**
 * A tag for a file's current contents, so an unchanged one is not sent twice.
 *
 * Every screen here is its own document, so moving between them re-requests
 * the whole web layer: two stylesheets and the module graph, about 100KB. On
 * a deployment that was 100KB and a second and a half of blank page on every
 * screen change, because `no-cache` with no validator means the browser must
 * ask and the server can only answer with the whole body. With a tag it asks
 * and is told 304, and the topbar is painted from cache immediately.
 *
 * Keyed on size and mtime rather than a hash of the contents: the check is a
 * stat, it runs on every request, and a deploy replaces the files anyway.
 */
const etagFor = (stats) => `W/"${stats.size.toString(16)}-${stats.mtimeMs.toString(16)}"`;

async function serveStatic(pathname, res, req) {
  // normalize() collapses any ../ before it can escape the web root.
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  const file = join(webRoot, rel);
  if (!file.startsWith(webRoot)) return false;

  try {
    const stats = await stat(file);
    if (!stats.isFile()) return false;

    const etag = etagFor(stats);

    // `no-cache` is kept deliberately: the browser still checks every time,
    // so a deploy is picked up on the next request rather than whenever a
    // max-age happens to lapse. What changes is the size of the answer.
    const headers = {
      ...SECURITY_HEADERS,
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
      etag
    };

    if (req?.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }

    res.writeHead(200, headers);
    res.end(req?.method === 'HEAD' ? undefined : await readFile(file));
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // HEAD is answered like GET without the body. It used to fall through to
  // the API router and 404 on files that plainly exist, which makes anything
  // that probes a URL before fetching it — a health check, a proxy — believe
  // the page is missing.
  if ((req.method === 'GET' || req.method === 'HEAD')
      && !url.pathname.startsWith('/api/')) {
    if (await serveStatic(url.pathname, res, req)) return;
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
    if (error instanceof IdempotencyConflict || error instanceof IdempotencyInFlight) {
      return json(res, error.status, { error: error.message });
    }
    if (error instanceof LedgerError) {
      // A rule was broken — the crew needs to know which, in their words.
      return json(res, 422, { error: error.message, code: error.code });
    }

    // "Supply a .xlsx or .csv file" is an answer, not a crash, and it reached
    // the office as "Something went wrong. Try again." — which reads as a
    // broken server and invites the retry that cannot work.
    if (error instanceof WorkbookError) {
      return json(res, 422, { error: error.message, code: 'BAD_WORKBOOK' });
    }

    // Message and stack, not the error object: a pg error carries the failing
    // statement and its parameter values, which for this system means client
    // material data copied into the logs of whoever can read them.
    console.error(`${req.method} ${url.pathname} failed:`, error.message, error.stack);
    json(res, 500, { error: 'Something went wrong. Try again.' });
  }
});

const port = Number(process.env.PORT ?? 3000);

// A drawing extraction lives in this process. If it restarted mid-read the
// job is not coming back, and a browser polling it would wait forever.
await failAbandonedJobs().catch((error) =>
  console.error('could not close out abandoned extraction jobs:', error));

server.listen(port, () => console.log(`fmr api listening on ${port}`));
