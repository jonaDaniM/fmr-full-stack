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
npm test                            # 159 tests, no database needed
```

Sign in by picking a seeded user. Jonathan D. is an owner and sees everything.

## Layout

```
packages/core/src/domain/     the rules — pure functions, no database
packages/core/src/services/   those rules applied in transactions
packages/core/test/           tests, all against the domain
packages/api/src/             http, auth, idempotency
packages/web/public/          five screens, no framework
packages/import/              workbook and CSV import, staging, drafts
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
