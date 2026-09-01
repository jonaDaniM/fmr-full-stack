/**
 * The one way this app talks to the server.
 *
 * Two things this fixes over the five copies it replaces. The error it throws
 * carries the server's `code`, so a screen can recognise LAST_OWNER without
 * matching on prose. And a network failure is no longer indistinguishable from
 * a signed-out session — every page used to redirect to sign-in on any error,
 * so a transient 500 quietly threw you out mid-shift.
 */

/** An error the server explained. `code` is the machine-readable half. */
export class ApiError extends Error {
  constructor(message, { code = null, status = 0 } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }

  /** The session is gone. The only case where a redirect to sign-in is right. */
  get isAuth() {
    return this.status === 401;
  }

  /** The request never landed. Worth retrying; not worth signing anyone out. */
  get isOffline() {
    return this.status === 0;
  }
}

/** Set once by the shell, read on every request. */
let projectId = null;

export function setProjectId(id) {
  projectId = id;
}

export function getProjectId() {
  return projectId;
}

/**
 * Call the API.
 *
 * `body` is JSON unless it is an ArrayBuffer, which the import upload sends
 * raw — that was the one genuine difference between the old copies.
 */
export async function api(path, options = {}) {
  const raw = options.raw || options.body instanceof ArrayBuffer;

  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers: {
        ...(raw ? {} : { 'content-type': 'application/json' }),
        ...(projectId ? { 'x-project-id': projectId } : {}),
        ...options.headers
      }
    });
  } catch {
    throw new ApiError('No connection. Check the network and try again.', { status: 0 });
  }

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new ApiError(body.error || 'Something went wrong.', {
      code: body.code ?? null,
      status: response.status
    });
  }

  return body;
}

/**
 * Upload with real progress.
 *
 * fetch cannot report upload progress, and the workbook limit is 25MB over
 * site wifi — long enough that a static "Reading…" line tells the user nothing
 * about whether it is working.
 */
export function upload(path, buffer, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', path);
    if (projectId) request.setRequestHeader('x-project-id', projectId);

    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };

    request.onload = () => {
      const body = (() => {
        try { return JSON.parse(request.responseText); } catch { return {}; }
      })();

      if (request.status >= 200 && request.status < 300) {
        onProgress?.(1);
        resolve(body);
      } else {
        reject(new ApiError(body.error || 'Something went wrong.', {
          code: body.code ?? null,
          status: request.status
        }));
      }
    };

    request.onerror = () =>
      reject(new ApiError('The upload did not reach the server.', { status: 0 }));

    request.send(buffer);
  });
}

/** A fresh idempotency key. Generate one per intent, not per click. */
export const idempotencyKey = () => crypto.randomUUID();
