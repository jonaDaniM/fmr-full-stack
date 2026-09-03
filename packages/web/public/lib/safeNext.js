/**
 * Where sign-in is allowed to send you afterwards.
 *
 * A session that expires mid-shift sends you to `/signin.html?next=<where you
 * were>` so the deep link survives (shell.js). That parameter comes out of the
 * URL bar, so anyone can write one — and after signing in the page assigns it
 * to `location.href`.
 *
 * The original test was `startsWith('/')`. A URL can pass that and still leave
 * the site: `//evil.example.com/x` is protocol-relative, and browsers read the
 * backslash in `/\evil.example.com` the same way. Both begin with a slash.
 *
 * That is an open redirect, and a sign-in page is the worst place to have one.
 * The link carries the real domain, the sign-in it shows is the real sign-in,
 * and the page it lands on afterwards belongs to whoever wrote the link —
 * which is exactly the shape of a phishing link that survives being checked.
 *
 * Nothing legitimate is lost by being strict: the app only ever puts
 * `location.pathname` in this parameter.
 *
 * Kept DOM-free, with the origin passed in, so `safe-next.test.js` can run it
 * over the strings an attacker would actually try.
 */

export function safeNext(raw, origin) {
  if (!raw) return '/home.html';

  try {
    const target = new URL(raw, origin);

    // Anything that resolved to another host, or to a different scheme —
    // javascript:, data: — is not somewhere this app sends anyone.
    if (target.origin !== origin) return '/home.html';

    const path = target.pathname + target.search + target.hash;

    // `new URL` resolves "/..//evil.com" to the path "//evil.com", which is
    // protocol-relative again the moment it is assigned to location.href.
    // One leading slash, always.
    return /^\/\//.test(path) ? '/home.html' : path;
  } catch {
    return '/home.html';
  }
}
