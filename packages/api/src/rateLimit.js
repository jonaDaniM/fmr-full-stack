/**
 * A ceiling on how often one address may try to sign in.
 *
 * Sign-in is the only route that acts before knowing who is calling, and each
 * attempt makes an outbound request to Google to verify the token — so an
 * unauthenticated caller can drive this server's egress with a loop.
 *
 * In process and in memory, which is the right size for this: one container,
 * thirty people, and a restart clearing the counts is not a weakness worth a
 * Redis for. Thirty crews signing in at shift change is nowhere near twenty
 * attempts from one address in five minutes.
 */

export const SIGNIN_LIMIT = { attempts: 20, windowMs: 5 * 60 * 1000 };

/**
 * The address to count against.
 *
 * Cloud Run appends the real caller to x-forwarded-for, so the last entry is
 * the one it set and everything before it is client-supplied. Reading the
 * first entry instead would let a caller change their own identity per
 * request and never be limited at all.
 */
export function callerAddress(req) {
  const forwarded = String(req.headers?.['x-forwarded-for'] ?? '').split(',');
  const last = forwarded[forwarded.length - 1].trim();
  return last || req.socket?.remoteAddress || 'unknown';
}

export function createRateLimiter({ attempts, windowMs } = SIGNIN_LIMIT, now = Date.now) {
  const seen = new Map();

  return {
    /** Record an attempt, and say whether this one is over the line. */
    exceeded(req) {
      const key = callerAddress(req);
      const at = now();

      const recent = (seen.get(key) ?? []).filter((time) => at - time < windowMs);
      recent.push(at);
      seen.set(key, recent);

      // Addresses that have gone quiet are dropped, so a long-running
      // container cannot accumulate an entry per address that ever called.
      if (seen.size > 1000) {
        for (const [address, times] of seen) {
          if (!times.some((time) => at - time < windowMs)) seen.delete(address);
        }
      }

      return recent.length > attempts;
    }
  };
}
