# FMR

Field Material Requisition tracking. A port of the FMRv3 Apps Script system
onto Postgres, keeping the workflow and replacing the spreadsheet underneath it.

## What this is

Crews search for a requisition line, then record what happened to the material:
found it, bagged it, issued it, or could not find it and raised a backorder.
The office reviews those backorders and decides.

The rules are unchanged from the Sheets version. What changed is underneath:

- **Per-line locking.** The Apps Script version held one global lock, so every
  action in the system queued behind every other. Actions now lock only the
  line they touch.
- **Idempotency.** A retry on a dropped connection replays the original
  result. Previously a double-tap could issue material twice.
- **Multiple projects.** One deployment, many job sites, kept apart in the
  database and checked on every request.
- **No index maintenance.** `Search_Index` and `Operational_Index` were hand-built
  because Sheets cannot scan. Postgres indexes replace them.

## Layout

```
db/migrations/     schema
db/seed/           demo data
packages/core/
  src/domain/      the rules — pure, no database
  src/services/    the rules applied to the database, in transactions
  test/            unit tests
packages/api/      http, auth, idempotency
packages/web/      field, office, owner and import interfaces
packages/import/   workbook extraction, profiles, staging
packages/migrate/  loading the old spreadsheet
```

The domain layer has no database dependency, which is why its tests run in
milliseconds and why the rules can be read on their own.

## Running it

```bash
npm install
createdb fmr
export DATABASE_URL=postgres://localhost/fmr
export SESSION_SECRET=$(openssl rand -hex 32)
export GOOGLE_CLIENT_ID=...apps.googleusercontent.com

npm run migrate
node db/seed/seed.js
npm run api          # http://localhost:3000
```

Sign-in expects a Google account already present in `users`. The seed creates
four; change the emails there to real ones to sign in.

## Tests

```bash
npm test
```

Covers the ledger, the backorder lifecycle, ISO search parsing, and a
randomised check that no sequence of actions can produce a state the schema
would reject.

## The ledger

Every line tracks:

| Column | Meaning |
|---|---|
| `qty_requested` | what the FMR asked for |
| `qty_confirmed_located` | found in stores |
| `qty_available` | located, unreserved, ready to issue |
| `qty_active_bagged` | reserved under a bag tag |
| `qty_issued` | handed over |
| `qty_pending_backorder` | awaiting an office decision |
| `qty_confirmed_backorder` | office committed to supplying it |
| `qty_not_yet_located` | derived: requested − located |
| `qty_remaining_requirement` | derived: requested − issued |

Two rules matter more than the rest:

**Located material is always accounted for.** `located = available + bagged + issued`,
enforced by a CHECK constraint, not just by the code.

**Pending backorders lock their quantity.** Material someone has asked the
office to source cannot be confirmed, reserved, or issued behind that request's
back. `locatableQuantity()` in `domain/ledger.js` is where this lives, and it
gates every action.

## Backorders

A request is raised by the field, then confirmed, rejected, or returned by the
office.

- **Confirm** — the office will supply it. Pending becomes confirmed.
- **Reject** — it will not be supplied. The lock is released so the crew can
  source it themselves, and they are told.
- **Return** — more information is needed. The quantity stays locked.

A partial return **splits** the request: the confirmed part stays on the
original row, the returned remainder becomes a new row linked by
`split_from_id`. This is easy to miss and the reason that column exists.

When material is later located, outstanding backorders settle against it
automatically — confirmed commitments first, oldest first.

## Notices

When the office decides on a backorder, the crew who raised it needs to know —
on the line's own card, in words that say what to do next. A rejection means
"nobody is sourcing this, go and find it." A return means "we need more from
you first."

A notice is outstanding work, not a log entry. It carries a quantity and is
settled as the crew works through it: locating material against a rejected
notice is what closes it, oldest notice first. Dismissing it is not an option,
because the material still has to be found.

## Corrections

People mis-key quantities. The fix is never an edit — the original transaction
is what actually happened, and an audit trail that can be rewritten is not one.
A correction writes the opposite entry and moves the ledger back.

Corrections are previewed before they are applied: this is the one operation
where quantities move without a physical event behind them, so the owner sees
the before and after first. A reason is required and kept. The same set of
transactions cannot be corrected twice.

## Operational controls

An owner can pause material movement on a project — during a cutover, a stock
count, or when the ledger needs to hold still. The pause is checked inside each
action's transaction, so one taken mid-action still holds, and crews are shown
the reason rather than an error.

Health reporting covers only what is specific to this workflow: backorders
nobody has decided on, notices the crews have not acted on, bags sitting
unissued. Backups and uptime are the database's job, not the application's.

## Integrity checks

The schema's CHECK constraints stop any single row going wrong, and cannot be
bypassed. What they cannot see is across rows: whether a line's backorder
totals match the requests behind them, whether bagged quantities match what the
bags hold, whether issued totals match the transaction history.

Seven such checks run read-only from the owner screen, each naming the rows it
found. One repair is offered — resetting line backorder totals from their
requests, since the requests are the record of what the office was actually
asked and what it decided.

## Import

Workbooks are parsed into a staging batch and reviewed before anything becomes
a real FMR. Errors block publishing; warnings do not. Quantities and sizes can
be corrected in the review screen.

Drawings keep a similar shape between projects but never quite the same one, so
the engine is fixed and the variation lives in a **profile** — a JSON file per
project naming the labels and column headings that project uses.
`packages/import/profiles/default.json` is the baseline; copy it and adjust.

Normalisation rules that hold everywhere live in `import/src/normalize.js`.
The one worth knowing about: Excel silently converts pipe sizes to dates when a
sheet is opened, so `1/2"` arrives as `2-Jan`. That is recovered, along with
mixed fractions, decimal sizes, and units inferred from the description — a
crew sent to find 20 feet of elbows has been sent wrong.

### XLSX parsing

The `xlsx` package on the npm registry is unmaintained and carries unfixed
prototype-pollution and ReDoS advisories, so it is deliberately **not** a
dependency. `packages/import/src/workbook.js` takes a parser by injection:
install SheetJS from their own CDN (`cdn.sheetjs.com`, the supported route) or
a maintained alternative, then call `setXlsxParser()`. CSV needs no parser and
works out of the box.

## Migrating the spreadsheet

```bash
node packages/migrate/src/index.js --dir=./export --project=GC-2026        # dry run
node packages/migrate/src/index.js --dir=./export --project=GC-2026 --apply
```

Export each sheet as CSV into one directory, keeping the sheet names.

The dry run validates every line against the invariants the database enforces
and reports what would fail. This matters: a spreadsheet lets quantities drift
out of agreement, and a database will not — so drift has to be found before the
load, not halfway through it. A batch with problems is refused rather than
partly applied.

## Not yet built

- The Python FMR generator (`industrial-iso-takeoff-toolkit`) wired into the UI
- Per-project extraction profiles beyond the baseline — these need real
  drawings from each project to tune
