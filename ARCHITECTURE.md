# FMR — schema and structure

Field material requisition tracking for industrial construction, replacing a
Google Apps Script system (`../FMRv3`).

Warehouse crews search for material against a drawing, record what they found,
bag it, issue it, or raise a backorder when it is not there. The office decides
those backorders. **The ledger of who has what is the whole point of the
system**, and most of what follows exists to keep that ledger honest.

For running the app, see [README.md](README.md). For the rules behind the
ledger, load the `fmr-domain` skill in `.claude/skills/`.

---

## The stack

| | |
|---|---|
| Runtime | Node 23, ES modules |
| Database | PostgreSQL 17 |
| Database access | `pg`, plain SQL, no ORM |
| Frontend | No framework, no build step; Bootstrap 5.3 via CDN |
| npm dependencies | **one** — `pg` |
| Tests | `node:test`, 182 tests, no database needed |

Nothing is transpiled or bundled. `.js` is served as a native ES module, so what
is on disk is what runs in the browser.

---

## Project structure

```
packages/
  core/src/domain/      1,030 lines   the rules — pure functions, no database
  core/src/services/    2,499 lines   those rules applied in transactions
  core/test/               16 files   tests, all against the domain
  api/src/              1,035 lines   http, auth, idempotency
  import/src/           1,753 lines   workbooks, CSVs, staging, drafts
  web/public/           5,453 lines   seven screens
  migrate/src/            390 lines   loading the old spreadsheet
  extract/                703 lines   Python: material out of drawing PDFs
  extract-iso/            ~2,600 lines  Python: the drawing reader itself
  import/src/runner.js                   spawns it, and is the only place that
                                         starts a process or writes to disk
db/migrations/               6 files   schema
scripts/check-ui.js                    enforces the web layer's rules
```

### Why `domain/` has no database import

The rules can be read and tested on their own, and the tests run in
milliseconds. If a rule needs a query to decide something, **the query belongs
in the service and the decision in the domain**. This is the one structural
constraint worth defending.

```
domain/     ledger.js  backorder.js  corrections.js  notices.js
            roles.js   isoKey.js     bagTag.js
              ↑ pure functions: state in, new state out

services/   field.js  backorderReview.js  corrections.js  admin.js
            search.js  reporting.js  integrity.js  controls.js
              ↑ transactions, locking, persistence

api/        server.js  auth.js  idempotency.js
              ↑ 44 routes, session cookies, security headers
```

### The web layer

Seven screens, no framework. Everything shared lives in `web/public/lib/`:

| File | What it is |
|---|---|
| `api.js` | one `api()`; throws `ApiError` carrying the server's `code` |
| `dom.js` | `$`, `esc`, `n`, `day`, `when`, `skeleton` |
| `modal.js` | the single accessible dialog — focus trap, restore, Escape |
| `toast.js` | three lifetimes: ok, error, sticky |
| `shell.js` | topbar, nav, project picker, `session` |
| `ceilings.js` | client mirror of the domain's action limits |

There were once five copies of `api`, `toast` and `esc`, and they had already
drifted — `n()` returned an em dash on two screens, which was then posted to
the server as a quantity. **Add to `lib/`; do not copy.**

`npm test` runs `scripts/check-ui.js`, which fails the build if any value
reaches HTML without passing through `esc()`. That is the whole XSS defence,
enforced rather than trusted.

---

## Database schema

20 tables, 205 constraints and indexes. Full DDL:

```bash
pg_dump -d fmr --schema-only --no-owner --no-privileges
```

### The shape of it

```
projects ─┬─ project_members ── users
          ├─ project_controls          pause switches + bag tag counter
          ├─ lists                     dropdown values, editable by the office
          │
          ├─ fmr_headers ── fmr_lines ─┬─ material_transactions   what happened
          │                            ├─ bag_tag_items ── bag_tags
          │                            ├─ backorder_requests ── field_notices
          │                            └─ corrections
          │
          └─ import_batches ── import_items ─┬─ import_lines
                                             └─ import_issues
```

### The core: `fmr_lines`

A line is a **requirement** — this drawing needs 120 feet of this pipe. It is
not a stock record. The system never claims to know what is in the warehouse,
only what has been found, reserved, and handed over against a specific
requirement.

Seven quantities, all `numeric(14,4)`:

| Column | What it means on the floor |
|---|---|
| `qty_requested` | what the drawing asks for |
| `qty_confirmed_located` | found in stores |
| `qty_available` | found, on the shelf, unreserved |
| `qty_active_bagged` | found, reserved under a bag tag |
| `qty_issued` | handed to the crew |
| `qty_pending_backorder` | the office has been asked, has not answered |
| `qty_confirmed_backorder` | the office said yes, it is coming |

Three columns are **generated and never written**:

```sql
qty_not_yet_located       GENERATED AS GREATEST(0, qty_requested - qty_confirmed_located)
qty_remaining_requirement GENERATED AS GREATEST(0, qty_requested - qty_issued)
iso_key                   GENERATED AS upper(iso_number) || '|' || upper(iso_sheet)
```

### The rule that governs everything

```sql
CONSTRAINT located_accounted_for
  CHECK (qty_confirmed_located = qty_available + qty_active_bagged + qty_issued)
```

Material that has been found is in exactly one of three places: on the shelf, in
a bag, or gone to the crew. This is a CHECK constraint, so **a service that gets
it wrong fails at the INSERT** rather than producing bad data that surfaces
three weeks later. That is deliberate.

`packages/core/test/schema-invariants.test.js` runs 400 randomised action
sequences against it. If you add an action, add it there.

Eight more checks guard the same table:

```sql
issued_within_requested   CHECK (qty_issued <= qty_requested)
                          plus every qty_* column >= 0
```

### Backorders lock material

```sql
backorder_requests
  qty_requested   what was asked for
  qty_confirmed   the office committed to supplying
  qty_pending     still undecided
  split_from_id   → backorder_requests(id)   a partial return splits in two
  status          Pending | Confirmed | Partially Confirmed
                  | Rejected | Returned for Review | Fulfilled
```

Quantities under a **pending** backorder cannot be located, reserved or issued.
Otherwise the requirement is counted twice: once as material found, once as
material on order. This gates every field action and is the most common source
of "why is it refusing this".

`split_from_id` is a self-reference: when the office returns part of a request,
the confirmed part stays on the original row and the returned remainder becomes
a new row pointing back at it. Miss this and quantities go wrong in a way that
is very hard to trace later.

### History is append-only

```sql
material_transactions        7 foreign keys — every movement is traceable
  correlation_id             groups the rows written by one action
  transaction_type           CONFIRM_AVAILABLE | BAG | DIRECT_ISSUE
                             | ISSUE_FROM_AVAILABLE | ISSUE_FROM_BAG
                             | BACKORDER_REQUESTED | CORRECTION_*
  source_bag_tag_id          → bag_tags
  target_bag_tag_id          → bag_tags
  backorder_request_id       → backorder_requests
```

Someone keys 100 instead of 10. The fix is an **opposite entry**, never an edit
or a delete: the original transaction is what actually happened, and an audit
trail that can be rewritten is not one. `corrections` records the reversal with
a `reversed_correlation_id`, and a partial unique index — `corrections_once`,
`WHERE status = 'Applied'` — stops the same transactions being corrected twice
while still allowing a failed attempt to be retried.

`id` here is `bigint`, not `uuid` — this is the one table that grows without
bound, and the ordering is meaningful.

### Bags

```sql
bag_tags        one physical bag: tag_number, storage_location, status
bag_tag_items   what is in it — bridges a bag to the lines it holds
                qty_remaining_in_bag GENERATED AS qty_bagged - qty_issued_from_bag
                UNIQUE (project_id, tag_number)
```

A bag can hold material from several lines, and a line can be spread across
several bags, so `bag_tag_items` is the join. Tag numbers are allocated from a
per-project counter in `project_controls` (`BT-2026-00001`), restarting each
calendar year — a crew in gloves does not type a tag number.

### Notices are work, not log lines

```sql
field_notices
  source_request_id  → backorder_requests
  kind               REJECTED | RETURNED | CONFIRMED
  status             Active | Resolved
```

A notice tells a crew what the office decided, on the line they raised it from.
It is **settled by doing the thing**, not by dismissing it: locating material
settles a rejected notice, re-raising a backorder settles a returned one, and
issuing from stock settles neither.

### Import

```sql
import_batches ── import_items ─┬─ import_lines
                                └─ import_issues   { severity, code, field | lineNumber }
```

Nothing publishes automatically. A batch is staged, validated, and a person
checks it in the drafts queue before a crew is sent looking for anything.
`import_issues` anchors each problem to the row or field that caused it.

### Permissions

`project_members` stores **four independent booleans**, not a role string:

```
search  fieldTransact  adminBackorder  ownerEdit
```

Four combinations have names (`READ_ONLY`, `FIELD`, `ADMIN`, `OWNER`); anything
else reports as `CUSTOM` and is preserved. **`ADMIN` is not a superset of
`FIELD`** — deciding backorders at a desk is a different job from issuing pipe
in a warehouse, and conflating them was a real risk worth encoding.

Guards, all server-side: the last active owner cannot be demoted or
deactivated, and nobody can deactivate themselves.

### Everything else

| Table | Purpose |
|---|---|
| `audit_log` | every mutation, with the actor and a reason |
| `idempotency_keys` | a retry after a dropped connection replays the original result instead of moving material twice |
| `extraction_jobs` | a package of drawings being read: the only asynchronous work, polled by the browser and closed out on restart |
| `lists` | dropdown values the office edits without a deploy |
| `project_controls` | pause field or import work, with a reason the crew sees |
| `schema_migrations` | applied migrations, by filename |

---

## Migrations

Forward-only, applied in filename order, recorded in `schema_migrations`.

```
001_init.sql                 projects, users, ledger, bags, transactions
002_import.sql               batches, items, lines, issues
003_notices_corrections.sql  field notices, corrections, project controls
004_manual_staging.sql       drafts typed by hand
005_admin.sql                members, lists, renumbering
006_bag_tag_sequence.sql     per-project bag tag counter
007_extraction_jobs.sql      drawing packages being read
```

```bash
npm run migrate          # apply pending
npm run start:reset      # drop, recreate, migrate, seed
```

---

## Conventions

- **Plain SQL through `pg`.** Parameters are always `$1`-style, never
  interpolated.
- **Cast parameters used in two ways.** Postgres cannot deduce a type for a
  parameter used as both a value and a comparison; write `$2::numeric`. This has
  bitten twice.
- **One client cannot run queries in parallel.** `await` them in sequence, or
  take a client each.
- **Every mutation writes an audit row.** Follow `services/corrections.js`.
- **Errors people see are `LedgerError`**, which the API answers 422 with the
  message shown verbatim. Write it for a warehouse hand, not a developer.
- **Row locks, not table locks.** Each field action takes `SELECT … FOR UPDATE`
  on the line it touches, so two people working different lines never block each
  other. The Apps Script version serialised the whole system behind one lock.

---
