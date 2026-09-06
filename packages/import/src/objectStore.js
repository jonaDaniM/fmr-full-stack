/**
 * Uploads that are too big to send through the app.
 *
 * Cloud Run's front end refuses any request body over 32MB, and refuses it
 * before the container sees it — so a large package failed with no log line
 * and no message a person could act on. The bytes therefore do not go through
 * this server at all: the browser is handed a short-lived signed URL, uploads
 * straight to Cloud Storage, and posts back only the object name.
 *
 * Signing needs the service account's private key. Rather than keep one on
 * disk, this asks IAM to sign on the account's behalf — the key stays inside
 * Google, there is no secret to rotate, and a leaked deployment leaks nothing.
 *
 * Unconfigured, `bucket()` returns null and every caller falls back to the
 * direct upload. That is what local development uses, where there is no front
 * end and no size limit to work around.
 */

import { createHash, randomUUID } from 'node:crypto';
import { LedgerError } from '../../core/src/domain/ledger.js';

const METADATA = 'http://metadata.google.internal/computeMetadata/v1';
const STORAGE = 'https://storage.googleapis.com';

/** How long a signed URL stays usable. Long enough for a slow site link. */
const URL_TTL_SECONDS = 15 * 60;

/** The bucket uploads land in, or null when this is not a deployment. */
export const bucket = () => process.env.FMR_UPLOAD_BUCKET || null;

/**
 * Who this container is running as.
 *
 * Asked of the metadata server rather than configured, so the deploy does not
 * have to name the service account it already runs under.
 */
let identity = null;
async function serviceAccount() {
  if (identity) return identity;

  const response = await fetch(`${METADATA}/instance/service-accounts/default/email`, {
    headers: { 'Metadata-Flavor': 'Google' }
  });
  if (!response.ok) {
    throw new LedgerError('Large uploads are not configured on this server.', 'NO_UPLOADS');
  }

  identity = (await response.text()).trim();
  return identity;
}

/**
 * An access token for the container's own service account.
 *
 * Not cached: the metadata server caches it already and hands back the same
 * token until it is close to expiring, so caching again here would only add a
 * way to hold a stale one.
 */
async function accessToken() {
  const response = await fetch(`${METADATA}/instance/service-accounts/default/token`, {
    headers: { 'Metadata-Flavor': 'Google' }
  });
  if (!response.ok) {
    throw new LedgerError('Large uploads are not configured on this server.', 'NO_UPLOADS');
  }
  return (await response.json()).access_token;
}

/** Ask IAM to sign these bytes as the service account. */
async function signBlob(payload) {
  const account = await serviceAccount();
  const token = await accessToken();

  const response = await fetch(
    'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/'
    + `${encodeURIComponent(account)}:signBlob`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ payload: Buffer.from(payload).toString('base64') })
    }
  );

  if (!response.ok) {
    // Almost always the one missing permission: the service account needs
    // roles/iam.serviceAccountTokenCreator on itself to sign as itself.
    console.error('signBlob failed:', response.status, await response.text());
    throw new LedgerError(
      'This server cannot authorise large uploads. Tell whoever set it up.',
      'SIGN_FAILED'
    );
  }

  return Buffer.from((await response.json()).signedBlob, 'base64').toString('hex');
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/** RFC 3986, which is stricter than encodeURIComponent about these four. */
const rfc3986 = (value) => encodeURIComponent(value)
  .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Percent-encode a path, leaving the separators alone. */
const encodePath = (path) => path.split('/').map(rfc3986).join('/');

/**
 * A V4 signed URL.
 *
 * Written out rather than taken from @google-cloud/storage because that
 * package and its transitive dependencies are a large amount of code to carry
 * for one signature, in a system whose only other dependency is `pg`.
 *
 * https://cloud.google.com/storage/docs/authentication/canonical-requests
 */
async function signedUrl(method, objectName, { contentType = null } = {}) {
  const name = bucket();
  if (!name) throw new LedgerError('Large uploads are not configured.', 'NO_UPLOADS');

  const account = await serviceAccount();
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]|\.\d{3}/g, '');   // 20260907T101530Z
  const day = stamp.slice(0, 8);

  const scope = `${day}/auto/storage/goog4_request`;
  const headers = contentType
    ? { host: 'storage.googleapis.com', 'content-type': contentType }
    : { host: 'storage.googleapis.com' };

  // Both lists must be sorted by lowercased header name, and must agree.
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((h) => `${h}:${headers[h].trim()}\n`).join('');
  const signedHeaders = names.join(';');

  const query = new URLSearchParams({
    'X-Goog-Algorithm': 'GOOG4-RSA-SHA256',
    'X-Goog-Credential': `${account}/${scope}`,
    'X-Goog-Date': stamp,
    'X-Goog-Expires': String(URL_TTL_SECONDS),
    'X-Goog-SignedHeaders': signedHeaders
  });

  // URLSearchParams encodes to form rules; the canonical request needs
  // RFC 3986, and the two differ on "/" and "+" — which appear in the
  // credential scope and in an email. Sorted by encoded key, as V4 requires.
  const canonicalQuery = [...query.entries()]
    .map(([key, value]) => [rfc3986(key), rfc3986(value)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  const resource = `/${name}/${encodePath(objectName)}`;

  const canonicalRequest = [
    method,
    resource,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD'
  ].join('\n');

  const toSign = [
    'GOOG4-RSA-SHA256',
    stamp,
    scope,
    sha256(canonicalRequest)
  ].join('\n');

  const signature = await signBlob(toSign);
  return `${STORAGE}${resource}?${canonicalQuery}&X-Goog-Signature=${signature}`;
}

/**
 * Where one upload will live.
 *
 * The server names the object, never the browser: a client-chosen path could
 * otherwise reach across projects or overwrite another upload. The project id
 * is in the path so an object can be checked against the caller before it is
 * read.
 */
export function objectNameFor(projectId, filename) {
  const cleaned = String(filename ?? '')
    .split(/[\\/]/).pop()
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120);

  const safe = cleaned.toLowerCase().endsWith('.pdf') ? cleaned : 'drawing.pdf';
  return `uploads/${projectId}/${randomUUID()}/${safe}`;
}

/** A URL the browser can PUT one file to, and nothing else. */
export const uploadUrl = (objectName, contentType) =>
  signedUrl('PUT', objectName, { contentType });

/**
 * Refuse an object that is not this project's.
 *
 * The browser sends back the object name it was given, and a name is not a
 * capability — checking the prefix is what stops one project's import naming
 * another's upload.
 */
export function assertOwnedBy(objectName, projectId) {
  const prefix = `uploads/${projectId}/`;
  if (typeof objectName !== 'string' || !objectName.startsWith(prefix)
      || objectName.includes('..')) {
    throw new LedgerError('That upload was not found.', 'NOT_FOUND');
  }
}

/** Read one uploaded object back, as the extractor wants it. */
export async function download(objectName) {
  const token = await accessToken();
  const response = await fetch(
    `${STORAGE}/storage/v1/b/${encodeURIComponent(bucket())}`
    + `/o/${encodeURIComponent(objectName)}?alt=media`,
    { headers: { authorization: `Bearer ${token}` } }
  );

  if (!response.ok) {
    console.error('upload fetch failed:', objectName, response.status);
    throw new LedgerError(
      'That upload could not be read back. Try sending it again.',
      'UPLOAD_GONE'
    );
  }

  return {
    name: objectName.split('/').pop(),
    data: Buffer.from(await response.arrayBuffer())
  };
}

/**
 * Delete an upload once it has been read.
 *
 * The bucket has a lifecycle rule as well, so a failure here costs a day of
 * storage rather than leaving client drawings sitting indefinitely — which is
 * why this never throws.
 */
export async function discard(objectName) {
  try {
    const token = await accessToken();
    await fetch(
      `${STORAGE}/storage/v1/b/${encodeURIComponent(bucket())}`
      + `/o/${encodeURIComponent(objectName)}`,
      { method: 'DELETE', headers: { authorization: `Bearer ${token}` } }
    );
  } catch (error) {
    console.error('could not delete upload:', objectName, error.message);
  }
}
