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
  test/            unit tests over the domain
packages/api/      http, auth, idempotency
packages/web/      field interface
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

## Not yet built

- Bulk import from Excel
- The Python FMR generator, wired into the UI
- Registers, ISO summaries, reporting
- Migration of existing spreadsheet data
