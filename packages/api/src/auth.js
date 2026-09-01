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

export class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

/** Verify a Google ID token and return its claims. */
export async function verifyGoogleToken(idToken) {
  const response = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`
  );
  if (!response.ok) throw new AuthError('Google sign-in could not be verified.');

  const claims = await response.json();

  if (claims.aud !== process.env.GOOGLE_CLIENT_ID) {
    throw new AuthError('This sign-in was issued for a different application.');
  }
  if (claims.email_verified !== 'true' && claims.email_verified !== true) {
    throw new AuthError('This Google account has no verified email address.');
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
      ownerEdit: row.can_owner_edit
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

  const { rows } = await pool.query(
    'SELECT * FROM users WHERE id = $1 AND active',
    [session.sub]
  );
  const user = rows[0];
  if (!user) throw new AuthError('This account is no longer active.');

  const projectId = req.headers['x-project-id'];
  if (!projectId) throw new AuthError('No project selected.', 400);

  const { rows: memberRows } = await pool.query(
    `SELECT * FROM project_members WHERE user_id = $1 AND project_id = $2`,
    [user.id, projectId]
  );
  const membership = memberRows[0];
  if (!membership) throw new AuthError('You do not have access to this project.', 403);

  return {
    user,
    projectId,
    permissions: {
      search: membership.can_search,
      fieldTransact: membership.can_field_transact,
      adminBackorder: membership.can_admin_backorder,
      ownerEdit: membership.can_owner_edit
    }
  };
}

/** Guard one capability. Checked per action, never assumed from sign-in. */
export function require(ctx, capability) {
  if (!ctx.permissions[capability]) {
    throw new AuthError('You do not have permission to do that.', 403);
  }
}
