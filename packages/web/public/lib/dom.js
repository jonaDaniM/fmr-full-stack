/**
 * The small things every screen needs.
 *
 * These existed five times over, one copy per page, and they had already
 * drifted: `n` returned 0 on two screens and an em dash on two others, which
 * put a literal "—" into a quantity cell that was then posted to the server.
 * One copy, so that cannot happen again.
 */

export const $ = (id) => document.getElementById(id);

/**
 * Escape a value for interpolation into HTML.
 *
 * These pages build markup by concatenation, so this is the whole of the XSS
 * defence. Every value going into an innerHTML string passes through here —
 * `npm run check:ui` fails the build if one does not.
 */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** A quantity, grouped and trimmed. Missing reads as zero, never as a dash. */
export const n = (v) => Number(v ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

/** A quantity that may legitimately be absent — for display only, never posted. */
export const nOrDash = (v) => (v == null || v === '' ? '—' : n(v));

/** A date, no time. */
export const day = (value) =>
  value ? new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—';

/** A date and time, for audit trails where the hour matters. */
export const when = (value) =>
  value
    ? new Date(value).toLocaleString(undefined,
        { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : '—';

/**
 * Build an element without going through innerHTML.
 *
 * Text set this way is never parsed as markup, so it cannot inject regardless
 * of what the server returned. Prefer this over a template string wherever the
 * content is a plain value.
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key.startsWith('data')) node.setAttribute(key.replace(/([A-Z])/g, '-$1').toLowerCase(), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }

  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }

  return node;
}

/** Replace a container's children with new nodes, without an innerHTML round trip. */
export function fill(target, ...children) {
  target.replaceChildren(...children.flat().filter((c) => c != null && c !== false));
  return target;
}

/**
 * Placeholder markup in the shape of what is coming.
 *
 * Loading used to replace the entire view with the word "Loading…", so every
 * tab and filter change blanked the stats and the filter row along with the
 * table, and the page flashed empty on a slow query.
 */
export const skeleton = ({ stats = 0, rows = 6 } = {}) => `
  ${stats ? `<div class="stats">${
    '<div class="skel skel-stat"></div>'.repeat(stats)}</div>` : ''}
  <div class="tw" style="padding:12px">${
    '<div class="skel skel-row"></div>'.repeat(rows)}</div>`;

/**
 * A table body that says something when there is nothing in it.
 *
 * Several tables rendered headers over a void when empty, which reads as
 * broken rather than as finished.
 */
export const emptyRow = (columns, message) =>
  `<tr class="empty-row"><td colspan="${columns}">${esc(message)}</td></tr>`;
