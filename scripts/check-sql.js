#!/usr/bin/env node
/**
 * The SQL rule this codebase keeps breaking, enforced rather than trusted.
 *
 * Postgres infers a parameter's type from how it is used. Use $1 as a uuid in
 * one place and as text in another and it refuses the whole statement with
 * 42P08 — "inconsistent types deduced for parameter". CLAUDE.md warns about
 * this ("this has bitten twice"), and the parity audit then found two more:
 *
 *   controls.js  $1 as project_id and as $1::text  → every pause and resume
 *                                                    failed with a 500
 *   admin.js     $3 inside CASE WHEN $2 THEN NULL  → deactivating any member
 *                ELSE $3 END                         failed with a 500
 *
 * Neither was visible to `npm test`: the domain tests deliberately have no
 * database, so a statement that never parses looks exactly like one that
 * works. This check reads the SQL instead.
 *
 * It flags two shapes and stays quiet about everything else — a check that
 * cries wolf is one people learn to ignore:
 *
 *   1. A parameter given two different casts ($1::uuid and $1::text) in one
 *      statement, which is a contradiction Postgres cannot resolve.
 *   2. A bare parameter in a CASE branch whose sibling branch is NULL, where
 *      Postgres has nothing but the NULL to go on and falls back to text.
 *
 * Run by `npm run check:sql`, and by `npm test`.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const searched = [
  'packages/core/src', 'packages/import/src', 'packages/api/src',
  // The migration runs once, against Jonathan's real spreadsheet, and a
  // statement that will not parse is worst discovered there.
  'packages/migrate/src', 'db/seed'
];

const problems = [];
const report = (file, line, message) =>
  problems.push(`${relative(root, file)}:${line}  ${message}`);

async function walk(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await walk(path));
    else if (entry.name.endsWith('.js')) found.push(path);
  }
  return found;
}

/**
 * Every template literal that looks like SQL, with the line it starts on.
 *
 * Backtick strings only — that is how every query in this codebase is
 * written, and it keeps the scan away from ordinary strings that merely
 * mention SELECT.
 */
function sqlLiterals(source) {
  const found = [];
  const pattern = /`([^`\\]|\\[\s\S])*`/g;

  for (const match of source.matchAll(pattern)) {
    const text = match[0].slice(1, -1);
    if (!/\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(text)) continue;
    if (!/\$\d/.test(text)) continue;
    found.push({ text, line: source.slice(0, match.index).split('\n').length });
  }
  return found;
}

/** Which line of the literal a character offset falls on. */
const lineAt = (text, index) => text.slice(0, index).split('\n').length - 1;

function checkStatement({ text, line }, file) {
  // --- 1. the same parameter both bare and cast
  const casts = new Map();          // $n → the casts it is given
  const bare = new Map();           // $n → line of a use with no cast
  const bareInValuesList = new Set();

  // The spans covered by an INSERT's VALUES list, where a bare parameter has
  // no column expression beside it to take a type from.
  const valuesSpans = [...text.matchAll(/\bVALUES\s*\(/gi)].map((m) => {
    let depth = 0;
    for (let i = m.index + m[0].length - 1; i < text.length; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')' && --depth === 0) return [m.index, i];
    }
    return [m.index, text.length];
  });
  const inValues = (index) =>
    valuesSpans.some(([from, to]) => index >= from && index <= to);

  for (const match of text.matchAll(/\$(\d+)(?:::\s*([a-zA-Z_]\w*(?:\s*\[\s*\])?))?/g)) {
    const [whole, number, cast] = match;
    const at = line + lineAt(text, match.index);

    if (cast) {
      const type = cast.trim().toLowerCase();
      if (!casts.has(number)) casts.set(number, new Map());
      casts.get(number).set(type, at);
    } else {
      if (!bare.has(number)) bare.set(number, at);
      if (inValues(match.index)) bareInValuesList.add(number);
    }
    void whole;
  }

  // A parameter needed at two types is fine as long as EVERY use says which —
  // `$1::uuid` beside `$1::text` is the deliberate fix in controls.js. The
  // fault is a use that leaves Postgres guessing while another use has already
  // pinned a different type. One cast beside a bare use in the ordinary
  // optional-filter idiom (`$2::text IS NULL OR col = $2`) is not a fault:
  // the single cast is what supplies the type. So this fires only when the
  // casts themselves disagree AND some use is left bare.
  for (const [number, types] of casts) {
    if (!bare.has(number)) continue;

    // Two casts and a bare use: nothing can reconcile them.
    if (types.size > 1) {
      report(file, Math.min(bare.get(number), ...types.values()),
        `$${number} is cast to ${[...types.keys()].join(' and ')} and also `
        + 'used bare — cast every use, or Postgres cannot deduce a type (42P08)');
      continue;
    }

    // One cast beside a bare use is only safe when the bare use sits against a
    // column that supplies the type — the optional-filter idiom
    // `$2::text IS NULL OR col = $2`. A bare use inside an INSERT's VALUES
    // list has no such column to lean on, so the cast elsewhere is the only
    // type information and it contradicts this use. That is what broke every
    // pause and resume in controls.js.
    if (bareInValuesList.has(number)) {
      const [type, castLine] = [...types.entries()][0];
      report(file, Math.min(bare.get(number), castLine),
        `$${number} is used bare in a VALUES list and as ::${type} elsewhere `
        + '— cast both uses, or Postgres cannot deduce a type (42P08)');
    }
  }

  // --- 2. a bare parameter in a CASE branch opposite a NULL
  //
  // CASE WHEN $2 THEN NULL ELSE $3 END gives Postgres only the NULL to infer
  // from, so $3 becomes text and a uuid column then rejects it.
  for (const match of text.matchAll(
    /\bCASE\b[\s\S]{0,200}?\bEND\b/gi
  )) {
    const branch = match[0];
    if (!/\bNULL\b/i.test(branch)) continue;

    for (const param of branch.matchAll(/\$(\d+)(?!\s*::)/g)) {
      // The WHEN condition itself is a boolean and is not at issue.
      const before = branch.slice(0, param.index);
      const inCondition = /\bWHEN\b[^\n]*$/i.test(before)
        && !/\b(THEN|ELSE)\b[^\n]*$/i.test(before);
      if (inCondition) continue;

      report(file, line + lineAt(text, match.index + param.index),
        `$${param[1]} sits in a CASE branch opposite NULL — cast it `
        + '(e.g. $' + param[1] + '::uuid), or Postgres infers text');
    }
  }
}

for (const dir of searched) {
  for (const file of await walk(join(root, dir))) {
    const source = await readFile(file, 'utf8');
    for (const statement of sqlLiterals(source)) checkStatement(statement, file);
  }
}

if (problems.length) {
  console.error(`\n${problems.length} SQL parameter problem${problems.length === 1 ? '' : 's'}:\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    '\nPostgres infers a parameter\'s type from its use. Two different uses of\n'
    + 'one parameter means it cannot, and the statement fails at runtime with\n'
    + '42P08 — which no test without a database will catch.\n'
  );
  process.exit(1);
}

console.log('sql: every parameter has one deducible type');
