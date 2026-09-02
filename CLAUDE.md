# FMR

Field material requisition tracking for industrial construction. A port of a
Google Apps Script system (`../FMRv3`) onto Postgres.

Warehouse crews search for material against a drawing, record what they found,
bag it, issue it, or raise a backorder when it is not there. The office decides
those backorders. The ledger of who has what is the whole point of the system.

## Running it

```bash
brew services start postgresql@17   # once
npm start                           # http://localhost:3000
npm run start:reset                 # wipe and start fresh
npm test                            # 173 tests + the web-layer check
```

Sign in by picking a seeded user. Jonathan D. is an owner and sees everything.

## Layout

```
packages/core/src/domain/     the rules — pure functions, no database
packages/core/src/services/   those rules applied in transactions
packages/core/test/           tests, all against the domain
packages/api/src/             http, auth, idempotency
packages/web/public/          seven screens, no framework
packages/web/public/lib/      the shared layer: api, dom, modal, toast, shell
scripts/check-ui.js           enforces the rules the web layer rests on
packages/import/              workbook, CSV and drawing import, staging, drafts
packages/extract/             Python: material out of drawing PDFs
packages/migrate/             loading the old spreadsheet
db/migrations/                schema
```

**The domain layer has no database dependency.** That is deliberate: the rules
can be read and tested on their own, and the tests run in milliseconds. Keep it
that way — if a rule needs a query to decide something, the query belongs in
the service and the decision in the domain.

## Conventions

- **Plain SQL through `pg`.** No ORM. Parameters are always `$1`-style, never
  interpolated.
- **Cast parameters used in two ways.** Postgres cannot deduce a type for a
  parameter used as both a value and a comparison; write `$2::numeric`. This
  has bitten twice.
- **One client cannot run queries in parallel.** `await` them in sequence, or
  take a client each.
- **Every mutation writes an audit row.** Follow `services/corrections.js`.
- **Errors people see are `LedgerError`,** which the API answers 422 with the
  message shown verbatim. Write it for a warehouse hand, not a developer.
- Tests are `node:test`, named as sentences describing the behaviour.

## The web layer

No framework, no build step, no npm packages — `.js` is served as a native ES
module, so `lib/` is imported directly. One stylesheet, `fmr.css`, holds the
tokens; per-screen CSS files hold only what one screen needs.

- **Everything shared lives in `lib/`.** There were once five copies of `api`,
  `toast` and `esc`, and they had already drifted — the toast timing differed,
  and `n()` returned an em dash on two screens, which was then posted to the
  server as a quantity. Add to `lib/`; do not copy.
- **One dialog: `lib/modal.js`.** It traps focus, restores it, and closes on
  Escape without leaking its listener. `confirmAction` and `askReason` replace
  `confirm()` and `prompt()` — a reason that the server refuses is kept, not
  thrown away.
- **Every value interpolated into HTML goes through `esc()`.** This is the
  whole XSS defence, and `npm test` fails if one does not.
- **Confirm in proportion to consequence.** Rejecting a backorder, resetting
  ledger totals and resuming work all ask first; they used to fire on one click
  while archiving a draft asked twice.
- **Guard what the page already knows.** The signed-in user is in `session`, so
  a self-deactivation is refused before the form, not after.
- The CSP forbids inline `<script>` and `onclick`. Bind listeners in JS.

## Reading drawings

Drawing PDFs are read by `packages/extract-iso`, a Python package, spawned from
`packages/import/src/runner.js`. That module is the only place in the system
that starts a process or writes to disk, and it should stay that way:
arguments are passed as an array with no shell, uploaded filenames are reduced
to a safe basename, and the temp directory is removed in a `finally`.

It is the one piece of asynchronous work here. The upload records a job and
returns; the browser polls. A job left running by a restart is failed on boot,
or the browser waits forever.

```bash
cd packages/extract-iso && python3 -m venv .venv && .venv/bin/pip install -e .
```

Without that venv the app runs and only drawing upload refuses.

## Things that are easy to get wrong

Load the `fmr-domain` skill before touching the ledger, backorders, notices or
corrections. The short version:

- Located material is always `available + bagged + issued`. A CHECK constraint
  enforces it, so a service that gets this wrong fails at the insert.
- Quantities under a **pending** backorder are locked and cannot be located,
  reserved or issued.
- Corrections write an opposite entry; they never edit or delete history.
- `ADMIN` is not a superset of `FIELD`. Office staff do not move material.

## State of things

Runs against PostgreSQL 17, verified end to end. Not yet deployed, and
Jonathan's live spreadsheet has not been migrated — `packages/migrate` has a
dry run that reports what would fail before anything is written.
