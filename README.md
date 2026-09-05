# FMR

Field Material Requisition tracking. A port of the FMRv3 Apps Script system
onto Postgres, keeping the workflow and replacing the spreadsheet underneath it.

For the database schema and how the packages fit together, see
[ARCHITECTURE.md](ARCHITECTURE.md).

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
packages/web/      field, office, owner, drafts and import interfaces
packages/import/   workbook extraction, profiles, staging
packages/migrate/  loading the old spreadsheet
```

The domain layer has no database dependency, which is why its tests run in
milliseconds and why the rules can be read on their own.

## Running it

```bash
brew services start postgresql@17    # once
npm install
npm start                            # http://localhost:3000
```

That creates the database, applies the migrations, seeds demo data if the
database is empty, and starts the server. `npm run start:reset` drops it first.

Sign in by picking one of the seeded users — start with Jonathan D., who is an
owner and can see every screen. This local sign-in only exists when
`FMR_DEV_LOGIN=1`, which `npm start` sets and no deployment should.

### Deploying

```bash
export DATABASE_URL=postgres://…
export SESSION_SECRET=$(openssl rand -hex 32)
export GOOGLE_CLIENT_ID=…apps.googleusercontent.com
npm run migrate && npm run api
```

Without `FMR_DEV_LOGIN`, sign-in is Google only, and an account must already
exist in `users` — an owner adds people from the owner screen.

## Tests

```bash
npm test            # 299, no database needed
npm run test:db     # 45 more, against a real Postgres
```

`npm test` covers the ledger, the backorder lifecycle, the approval chain, ISO
search parsing, and a randomised check that no sequence of actions can produce
a state the schema would reject. It needs no database, which is why it runs in
under a second.

`test:db` covers what a pure test cannot see — a constraint firing, a profile
read back out of the database, publishing actually refused. Set
`FMR_TEST_DATABASE_URL` to run it; without one it skips.

The Python extractor has its own suite:

```bash
cd packages/extract-iso && .venv/bin/python3 -m pytest tests/ -q   # 50
```

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

## Drafts

An FMR arrives two ways: parsed out of a workbook, or typed in by hand. Both
land in the same queue, get corrected in the same screen, and go out through
the same publish path — where one came from stops mattering once it is waiting.

Saving is lenient and publishing is strict, which is how FMRv3 drew the line
too: someone typing up a requisition can stop halfway and come back, with the
gaps recorded against the draft rather than refused. Publishing re-validates
from stored state, so the button reflects what the server will actually decide
rather than a stored flag that may be stale.

Lines can be pasted straight from a spreadsheet, tab- or comma-separated, and
go through the same normalisation as imported ones — a hand-typed `1-1/2` and
an imported one end up identical.

Archiving takes a draft out of the queue without losing it. Restoring keeps the
same id, and fails if another draft has taken its FMR number meanwhile. That
rule is a partial unique index rather than a procedural check, so unlike FMRv3
it also holds on create.

## Users and lists

Roles are five named permission sets. `ADMIN` is deliberately not a superset of
`FIELD`: deciding backorders from a desk is a different job from issuing pipe
in a warehouse. `PLANNER` follows the same logic — reviewing a package is not
owning the numbering series.

| Profile | Search | Field | Backorders | Review | Number | Owner |
|---|---|---|---|---|---|---|
| Read Only | ✓ | | | | | |
| Field User | ✓ | ✓ | | | | |
| Planner | ✓ | | | ✓ | | |
| Material Admin | ✓ | | ✓ | | ✓ | |
| System Owner | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

A permission set matching none of these reports as `CUSTOM` and is left alone.
FMRv3's editor silently coerced it to Read Only, so opening such a user and
saving stripped their access.

Three guards, all enforced in the service rather than the browser: the last
active owner cannot be demoted or deactivated, nobody can deactivate
themselves, and deactivating needs a reason. The second is new — FMRv3 had no
such check, so an owner could lock themselves out.

Deactivation flags a user, never deletes them: their name still has to resolve
on every transaction they ever performed.

The dropdown lists the crews see — backorder reasons, units, priorities,
storage locations — are editable from the owner screen. In FMRv3 they could
only be changed by editing the spreadsheet, so adding a reason meant finding
someone with access to it. Storage locations stay free text with suggestions,
since a warehouse invents new ones faster than anyone maintains a list.

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

Drawings, workbooks and CSVs are parsed into a staging batch and reviewed
before anything becomes a real FMR. Errors block publishing; warnings do not.
Quantities and sizes can be corrected in the review screen.

### Drawings

Drop an IWP package of drawing PDFs on the import screen and the material on
each one becomes an FMR to check. The reading is done by
`packages/extract-iso`, a Python package that takes the bill of materials off
the sheet:

```bash
cd packages/extract-iso
python3 -m venv .venv && .venv/bin/pip install -e .
```

`start-local.sh` finds that venv on its own. Without it everything else still
works and only the drawing upload refuses, saying the reader is not installed.

Reading a package takes longer than a request should be held open, so the
upload answers with a job and the browser asks how it is going until there is
a batch to review — the one piece of asynchronous work in the system. A job
left running by a restart is closed out on boot.

A drawing carries no FMR number; the office issues those. One is proposed from
the drawing number so a reviewer has something to accept or change, and it is
flagged so it never looks like a number somebody chose. If a draft is already
waiting under that number, the sheet still arrives for review but without it.

The review screen also says what the package would have cost to type by hand —
"about 2.5 hours of typing" for a 51-drawing package. The model behind that is
`domain/timeSaved.js`, ported from measurements taken against a real operator,
and it is deliberately a floor: finding the email, downloading the package and
checking the result afterwards are all excluded.

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

## Approval chain

An FMR reaches a crew only after two decisions, by two different people:

```
DRAFT → with the planner → approved → waiting for a number → numbered → published
```

The planner checks the requisition suits the work package, and may return it
with a note; a corrected one re-enters review rather than going around it. The
material manager assigns the official FMR number and releases it. Publishing
is refused from any other state, and every move is audited with who and when.

Rules in `core/src/domain/workflow.js` (pure), applied by
`import/src/workflow.js`. The queue is `/review.html`, which shows each person
only what is waiting on them.

## Material takeoff

The document the material team buys from, before any FMR exists. Same drawing
scan, different question: `POST /api/import/takeoff` returns the takeoff form
as CSV, split by how material is bought — pipe and fittings, bolts and gaskets,
everything else — with pipe by the foot and the pipe schedule read off each
drawing.

`packages/extract-iso/src/iso_bom/mto.py` holds the classification rules, and
`packages/import/src/mto.js` writes the document.

## Not yet built

- **Line swap** — borrowing material from another line, with the donor left
  visibly owed replacement rather than silently short
- **A profile editor.** The engine already takes the profile as data and
  `/api/import/stage` already accepts `?profile=<name>`, but nothing in the UI
  ever sets it, so every import runs on `default.json`. What is missing is the
  screen to choose and edit one, not the plumbing under it.
- The Python FMR generator (`industrial-iso-takeoff-toolkit`) wired into the UI
- Per-project extraction profiles beyond the baseline — these need real
  drawings from each project to tune
