#!/usr/bin/env node
/**
 * The rules the web layer depends on, enforced rather than trusted.
 *
 * These pages build HTML by string concatenation, which is safe exactly as
 * long as every interpolated value goes through esc(). That discipline held
 * while one person wrote it; this is what keeps it holding afterwards.
 *
 * The interpolation check is deliberately narrow: it flags a bare property
 * read of server data — `${line.description}` — and stays quiet about
 * everything it cannot judge. A check that cries wolf is one people learn to
 * ignore, which is worse than no check at all.
 *
 * Run by `npm run check:ui`, and by `npm test`.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const webRoot = join(root, 'packages/web/public');

const problems = [];

async function walk(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await walk(path));
    else if (/\.(js|html)$/.test(entry.name)) found.push(path);
  }
  return found;
}

const report = (file, line, message) =>
  problems.push(`${relative(root, file)}:${line}  ${message}`);

/** Strip comments and string literals, so their contents are never matched. */
function stripNoise(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^[ \t]*\/\/.*$/gm, (m) => ' '.repeat(m.length))
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * Every `${...}` in the source, with its nesting handled.
 *
 * A regex cannot do this: `${a ? `x${b}` : ''}` closes at the wrong brace and
 * the truncated text then looks unsafe when it is not.
 */
function interpolations(source) {
  const found = [];

  for (let i = 0; i < source.length - 1; i += 1) {
    if (source[i] !== '$' || source[i + 1] !== '{') continue;

    let depth = 1;
    let j = i + 2;
    while (j < source.length && depth > 0) {
      if (source[j] === '{') depth += 1;
      else if (source[j] === '}') depth -= 1;
      j += 1;
    }
    if (depth !== 0) continue;

    const expression = source.slice(i + 2, j - 1);
    const line = source.slice(0, i).split('\n').length;
    found.push({ expression, line });
    i = j - 1;
  }

  return found;
}

/**
 * Template literals that build HTML.
 *
 * A literal counts if it opens a tag. Everything else — a URL, a selector,
 * a sentence for a toast — never reaches innerHTML and is left alone.
 */
function markupLiterals(source) {
  const found = [];

  for (let i = 0; i < source.length; i += 1) {
    if (source[i] !== '`') continue;

    let j = i + 1;
    let depth = 0;
    while (j < source.length) {
      const c = source[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '$' && source[j + 1] === '{') { depth += 1; j += 2; continue; }
      if (c === '}' && depth > 0) { depth -= 1; j += 1; continue; }
      if (c === '`' && depth === 0) break;
      j += 1;
    }

    const text = source.slice(i + 1, j);
    if (/<[a-z][\w-]*[\s>/]/i.test(text)) {
      found.push({ text, line: source.slice(0, i).split('\n').length });
    }
    i = j;
  }

  return found;
}

/**
 * Values that are never server data, so never a vector.
 *
 * `summary` and `count` fields are numbers the server computed; `dataset.*` is
 * read back out of an attribute this code already escaped on the way in; the
 * SCREENS and profile constants are written in this repo, not fetched.
 */
const NEVER_TAINTED = [
  /^[\w.]*summary\.\w+$/,           // batch.summary.errors — counts
  /^[\w.]*\b(count|repaired|problemCount|lineCount|errorCount|warningCount)\b$/,
  /^[\w.]*dataset\.\w+$/,            // already escaped when it was written
  /^(screen|p)\.(href|key|label|description|need|id)$/, // module constants
  /^copy\.\w+$/,                     // DECISION_COPY, defined in the file
  /^ACTION_LABELS\[/                 // ditto
];

/**
 * Is this expression safe to drop into HTML?
 *
 * Safe means: it does not end with a bare property read of data the server
 * sent. Anything that goes through esc/n/day/when, anything built from nested
 * templates that themselves pass this test, and anything that is plainly a
 * number or a boolean, all qualify.
 */
function isSafe(expression) {
  const trimmed = expression.trim();

  if (NEVER_TAINTED.some((pattern) => pattern.test(trimmed))) return true;

  // A nested template: check what it interpolates, not the template itself.
  if (trimmed.includes('${')) {
    return interpolations(trimmed).every((inner) => isSafe(inner.expression));
  }

  // Wrapped in something that escapes or produces a number.
  if (/^(esc|n|nOrDash|day|when|Number|String|encodeURIComponent|skeleton|emptyRow|render\w*|column|textField|statusPill)\s*\(/.test(trimmed)) {
    return true;
  }

  // A comparison, a boolean, a literal, or arithmetic — never raw text.
  if (/^[\d'"`]/.test(trimmed)) return true;
  if (/(===|!==|>=|<=|[<>])/.test(trimmed) && !/\?/.test(trimmed)) return true;
  if (/^!/.test(trimmed)) return true;

  // A count or an array operation.
  if (/\.(length|size)\s*$/.test(trimmed)) return true;
  if (/\.(map|filter|join|slice|reduce)\s*\(/.test(trimmed)) return true;

  // A local constant that this file defines as literal markup.
  if (/^[a-z][\w]*$/i.test(trimmed) && !/\./.test(trimmed)) return true;

  // A ternary: both branches must be safe.
  const ternary = trimmed.match(/^([^?]+)\?([\s\S]*)$/);
  if (ternary) {
    const rest = ternary[2];
    let depth = 0;
    for (let i = 0; i < rest.length; i += 1) {
      const c = rest[i];
      if (c === '(' || c === '[' || c === '{') depth += 1;
      else if (c === ')' || c === ']' || c === '}') depth -= 1;
      else if (c === ':' && depth === 0) {
        return isSafe(rest.slice(0, i)) && isSafe(rest.slice(i + 1));
      }
    }
  }

  // What is left is a property read: `line.description`, `r.fmrNumber`.
  return false;
}

for (const file of await walk(webRoot)) {
  const raw = await readFile(file, 'utf8');
  const source = stripNoise(raw);
  const isHtml = file.endsWith('.html');

  source.split('\n').forEach((code, index) => {
    const at = index + 1;

    // 1. No native dialogs. They cannot be styled, cannot validate inline, and
    //    throw away what was typed when the server refuses. lib/modal.js
    //    replaces all three.
    const native = code.match(/(?<![.\w$])(alert|confirm|prompt)\s*\(/);
    if (native) report(file, at, `native ${native[1]}() — use lib/modal.js instead`);

    // 2. No inline script and no inline handlers: the CSP blocks both, so a
    //    page carrying one is broken, not merely untidy.
    if (/<\s*script(?![^>]*\bsrc=)[^>]*>/.test(code)) {
      report(file, at, 'inline <script> — the CSP blocks it; use a .js file');
    }
    if (isHtml && /\son(click|change|submit|input|load|error)\s*=\s*["']/.test(code)) {
      report(file, at, 'inline event handler — the CSP blocks it; bind in JS');
    }
  });

  // 3. Every value interpolated into HTML must be escaped.
  //
  //    Only template literals that actually build markup are checked. The same
  //    syntax is used for URLs, CSS selectors and toast text, and none of those
  //    reach innerHTML — flagging them would bury the findings that matter.
  if (!isHtml) {
    for (const literal of markupLiterals(source)) {
      for (const { expression, line } of interpolations(literal.text)) {
        if (isSafe(expression)) continue;
        const shown = expression.trim().replace(/\s+/g, ' ').slice(0, 60);
        report(file, literal.line + line - 1, `unescaped interpolation: \${${shown}}`);
      }
    }
  }
}

if (problems.length) {
  console.error(`\n${problems.length} problem${problems.length === 1 ? '' : 's'} in the web layer:\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error('');
  process.exit(1);
}

console.log('web layer: no native dialogs, no inline script, every interpolation escaped');
