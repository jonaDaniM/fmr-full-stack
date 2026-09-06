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
npm test                            # 352 tests + the web and SQL checks
npm run test:db                     # 64 more, against a real Postgres
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
- **Publishing is gated on the approval chain**, not on a permission alone.
  An FMR reaches `PUBLISHED` only from `NUMBER_ASSIGNED` — see
  `domain/workflow.js`, which is pure and holds every legal move.
- **A new permission means four places, not one.** `domain/roles.js`, the
  `SELECT` and the `INSERT` in `services/admin.js`, and both queries in
  `api/src/auth.js`. Miss the `SELECT` and profiles silently read as CUSTOM;
  that has now happened twice.

## State of things

Deployed, and carrying the client's real data — 837 FMRs, 5,706 lines, 22
Turner Industries users. `packages/migrate` did the load; its dry run still
reports what would fail before anything is written.

Seventeen commits are ahead of the deployed revision, including migrations
`011`, `012` and `013`. **All three must run before the new code serves** —
publishing references `workflow_state`, and the review queue and import
profiles reference tables the deployed schema does not have.

Migration `012` adds Line Swap. Two rules there are easy to undo by accident:
lending reduces the donor's located **and** available totals and never touches
`qty_requested` (otherwise a donor gains credit for material it gave away), and
`lockPair` locks both lines lowest-id-first (otherwise two crews borrowing from
each other deadlock). Recording a repayment settles the obligation only — it
must not credit the donor's shelf.

Migration `013` moves import profiles into the database, per project, and adds
the tuning screen. The files in `packages/import/profiles/` stay as baselines.

What the client has asked for and is not built: automatic matching of incoming
deliveries to open swaps, and learning a layout from a file already imported
correctly.
