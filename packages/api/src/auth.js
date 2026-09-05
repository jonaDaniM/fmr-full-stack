/**
 * Authentication and authorisation.
 *
 * Identity comes from Google: the team signs in with the accounts they
 * already use. A verified Google token is exchanged for a session cookie.
 *
 * Permissions are per project, so someone can run materials on one job site
 * and have no access to another.
 */

import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { pool } from '../../core/src/db/pool.js';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // a long shift, then sign in again

/** The shape of every id this system hands out, used to refuse junk early. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

/** Who Google says issues its identity tokens. Both spellings are current. */
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

/**
 * Verify a Google ID token and return its claims.
 *
 * The tokeninfo endpoint checks the signature and expiry before it answers,
 * so those are not re-derived here. Every claim this system's own decisions
 * rest on is checked here regardless: relying on another service's validation
 * without stating what is being relied on is how a check goes missing.
 */
export async function verifyGoogleToken(idToken) {
  const expectedAudience = process.env.GOOGLE_CLIENT_ID;
  if (!expectedAudience) {
    // Without this there is nothing to compare aud against, and every token
    // would be accepted. Refusing to sign anyone in is the safe failure.
    throw new AuthError('Google sign-in is not configured on this server.', 500);
  }

  const response = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`
  );
  if (!response.ok) throw new AuthError('Google sign-in could not be verified.');

  const claims = await response.json();

  if (claims.aud !== expectedAudience) {
    throw new AuthError('This sign-in was issued for a different application.');
  }
  if (!GOOGLE_ISSUERS.has(claims.iss)) {
    throw new AuthError('This sign-in did not come from Google.');
  }
  // Seconds since the epoch, as a string. Expired tokens do not reach here,
  // but that is the endpoint's behaviour rather than a guarantee to inherit.
  if (!(Number(claims.exp) * 1000 > Date.now())) {
    throw new AuthError('That sign-in has expired. Try again.');
  }
  if (claims.email_verified !== 'true' && claims.email_verified !== true) {
    throw new AuthError('This Google account has no verified email address.');
  }
  if (!claims.email) {
    throw new AuthError('This Google account has no email address.');
  }

  return { email: String(claims.email).toLowerCase(), name: claims.name || claims.email };
}

/** Look up a user by email. Accounts are provisioned by an admin, not on sign-in. */
export async function findUser(email) {
  const { rows } = await pool.query(
    'SELECT * FROM users WHERE email = $1 AND active',
    [String(email).toLowerCase()]
  );
  return rows[0] ?? null;
}

export async function recordLogin(userId) {
  await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
}

// --- who tried to get in ---------------------------------------------------

/**
 * Record a sign-in, a sign-out, or a refusal.
 *
 * Nothing in this path used to be written down. Cloud Run logs the status code
 * and the caller's address, so a refused sign-in was visible as a 403 and
 * nothing more — not which account was refused, and not why. With 22 people on
 * the system that is the event most worth being able to ask questions about
 * later, and it was the one event nobody could.
 *
 * These rows go in `audit_log` beside the material history rather than to
 * stdout: log retention is 30 days, and a question about who was let in gets
 * asked long after that.
 *
 * A refusal has no user and no project, which is why both columns are
 * nullable. Never record the token or the cookie — the address attempted and
 * the reason are the whole story, and the credential is not ours to keep.
 */
export async function auditAuth(action, { email, userId = null, reason = null, ip = null }) {
  try {
    await pool.query(
      `INSERT INTO audit_log
         (project_id, entity_type, entity_id, action, payload, user_id, user_email,
          source_interface)
       VALUES (NULL,'AUTH',$1,$2,$3,$4,$5,'AUTH')`,
      [
        String(email ?? 'unknown').toLowerCase(),
        action,
        { reason, ip },
        userId,
        email ? String(email).toLowerCase() : null
      ]
    );
  } catch (error) {
    // Never let bookkeeping refuse a sign-in that should succeed, or mask the
    // real reason for one that should not.
    console.error('could not write an auth audit row:', error.message);
  }
}

/** Every project this user can reach, with what they may do in each. */
export async function membershipsFor(userId) {
  const { rows } = await pool.query(
    `SELECT m.*, p.code, p.name, p.timezone
       FROM project_members m
       JOIN projects p ON p.id = m.project_id
      WHERE m.user_id = $1 AND p.active
      ORDER BY p.name`,
    [userId]
  );

  return rows.map((row) => ({
    projectId: row.project_id,
    code: row.code,
    name: row.name,
    timezone: row.timezone,
    role: row.role,
    permissions: {
      search: row.can_search,
      fieldTransact: row.can_field_transact,
      adminBackorder: row.can_admin_backorder,
      ownerEdit: row.can_owner_edit,
      planReview: row.can_plan_review,
      assignNumber: row.can_assign_number
    }
  }));
}

// --- session cookies -------------------------------------------------------

function sign(payload) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not configured.');

  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function unsign(token) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || typeof token !== 'string') return null;

  const [body, mac] = token.split('.');
  if (!body || !mac) return null;

  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function issueSession(user) {
  return sign({
    sub: user.id,
    email: user.email,
    sid: randomUUID(),
    exp: Date.now() + SESSION_TTL_MS
  });
}

/**
 * End a session for good, not just in the browser that held it.
 *
 * The token is stateless, so clearing the cookie only persuades one browser to
 * forget it. A cookie copied beforehand stayed valid for the rest of its
 * twelve hours — which on a shared warehouse terminal is the whole point of
 * signing out.
 */
export async function revokeSession(session) {
  if (!session?.sid) return;
  await pool.query(
    `INSERT INTO revoked_sessions (sid, user_id, expires_at)
     VALUES ($1, $2, to_timestamp($3::bigint / 1000.0))
     ON CONFLICT (sid) DO NOTHING`,
    [session.sid, session.sub, session.exp]
  );
}

/** Revocations only have to outlive the tokens they revoke. */
export async function purgeRevokedSessions() {
  const { rowCount } = await pool.query(
    'DELETE FROM revoked_sessions WHERE expires_at < now()'
  );
  return rowCount;
}

export function readSession(cookieHeader) {
  const cookies = Object.fromEntries(
    String(cookieHeader ?? '')
      .split(';')
      .map((part) => part.trim().split('='))
      .filter(([k, v]) => k && v)
      .map(([k, ...v]) => [k, v.join('=')])
  );
  return unsign(cookies.fmr_session);
}

/**
 * Resolve the caller into { user, projectId, permissions }.
 *
 * Project membership is checked on every request, not just at sign-in: this
 * is what keeps one job site's material out of another's.
 */
export async function authenticate(req) {
  const session = readSession(req.headers.cookie);
  if (!session) throw new AuthError('Please sign in.');

  const projectId = req.headers['x-project-id'];
  if (!projectId) throw new AuthError('No project selected.', 400);

  // The header is client-supplied and goes into the query as a uuid. Postgres
  // refuses a malformed one — safely, as a parameter, never interpolated — but
  // it refuses it as a 500 with a stack trace, so anything sending junk here
  // fills the log with noise that buries real errors. Checking the shape first
  // makes that a plain 400.
  if (!UUID.test(projectId)) throw new AuthError('That project id is not valid.', 400);

  // One round trip, on the hot path of every API call: the user, whether this
  // session was signed out, and the membership that decides what they may do.
  // The membership is a LEFT JOIN so that "no such project for you" stays
  // distinguishable from "no such user".
  const { rows } = await pool.query(
    `SELECT u.*,
            m.can_search, m.can_field_transact,
            m.can_admin_backorder, m.can_owner_edit,
            m.can_plan_review, m.can_assign_number,
            m.project_id,
            EXISTS (SELECT 1 FROM revoked_sessions r WHERE r.sid = $3) AS revoked
       FROM users u
       LEFT JOIN project_members m
         ON m.user_id = u.id AND m.project_id = $2
      WHERE u.id = $1 AND u.active`,
    [session.sub, projectId, session.sid ?? null]
  );

  const row = rows[0];
  if (!row) throw new AuthError('This account is no longer active.');
  if (row.revoked) throw new AuthError('You have been signed out. Please sign in again.');
  if (!row.project_id) throw new AuthError('You do not have access to this project.', 403);

  return {
    user: row,
    projectId,
    permissions: {
      search: row.can_search,
      fieldTransact: row.can_field_transact,
      adminBackorder: row.can_admin_backorder,
      ownerEdit: row.can_owner_edit,
      planReview: row.can_plan_review,
      assignNumber: row.can_assign_number
    }
  };
}

/** Guard one capability. Checked per action, never assumed from sign-in. */
export function require(ctx, capability) {
  if (!ctx.permissions[capability]) {
    throw new AuthError('You do not have permission to do that.', 403);
  }
}
