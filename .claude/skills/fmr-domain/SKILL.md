---
name: fmr-domain
description: The material ledger rules — how quantities move between located, available, bagged and issued; how backorders lock material and settle; how notices reach the crew; how corrections work. Load before changing anything in packages/core/src/domain or services, before adding a field action or backorder decision, before touching the fmr_lines schema, or when a quantity is coming out wrong.
---

# The material ledger

Everything here exists because a warehouse hand is standing at a rack with a
phone, and the number on the screen has to match the steel in front of them.

## What a line is

An FMR line is a **requirement**: this drawing needs 120 feet of this pipe.
It is not a stock record. The system never claims to know what is in the
warehouse — only what has been found, reserved, and handed over against a
specific requirement.

Seven quantities, all on `fmr_lines`:

| Column | What it means on the floor |
|---|---|
| `qty_requested` | what the drawing asks for |
| `qty_confirmed_located` | found in stores |
| `qty_available` | found, on the shelf, unreserved |
| `qty_active_bagged` | found, reserved under a bag tag |
| `qty_issued` | handed to the crew |
| `qty_pending_backorder` | the office has been asked, has not answered |
| `qty_confirmed_backorder` | the office said yes, it is coming |

And two the database derives, which you never write:

- `qty_not_yet_located` = `requested - located`
- `qty_remaining_requirement` = `requested - issued`

## The rule that governs everything

```
located = available + bagged + issued
```

Material that has been found is in exactly one of three places: on the shelf,
in a bag, or gone to the crew. `located_accounted_for` is a CHECK constraint,
so a service that gets this wrong does not produce bad data — it fails at the
insert. That is intentional.

`packages/core/test/schema-invariants.test.js` runs 400 random action
sequences against it. If you add an action, add it there.

## The six field actions

Each is a pure function in `domain/ledger.js`, applied by `services/field.js`
inside one transaction with `SELECT … FOR UPDATE` on the line.

| Action | Movement |
|---|---|
| `CONFIRM_AVAILABLE` | not-located → located + available |
| `BAG` | available → bagged, locating first if short |
| `DIRECT_ISSUE` | not-located → located + issued, skipping the shelf |
| `ISSUE_FROM_AVAILABLE` | available → issued |
| `ISSUE_FROM_BAG` | bagged → issued, from one named bag |
| `BACKORDER_REQUESTED` | raises a request, locks the quantity |

Two are subtler than they look:

**`BAG` can locate and reserve in one step.** Someone bagging 50 when only 30
is on the shelf has just found the other 20. `applyBag` returns the newly
located amount, and that return value drives backorder settlement — ignoring
it means backorders never settle.

**`DIRECT_ISSUE` never touches available.** The crew found it and walked off
with it; it was never on a shelf.

## Backorders lock material

`locatableQuantity` is the rule everything else is built on:

```js
max(0, min(notYetLocated, remaining) - pendingBackorder)
```

Material somebody has asked the office to source **cannot be located, reserved
or issued** while that request is open. Otherwise the requirement is counted
twice: once as material found, once as material on order.

This gates every action. It is the single most common source of a "why is it
refusing this" question, and the answer is almost always a pending backorder.

## Settling backorders

When material is located, `planLocationTransitions` settles what is
outstanding, in this order:

1. **Confirmed commitments first, oldest first.** The office promised to
   supply it; the material turning up fulfils that promise.
2. **Pending requests take the remainder.** It arrived before anyone decided.

If the line's confirmed total does not match its open requests, this throws
rather than guessing. That mismatch is a real data problem — `services/
integrity.js` finds it, and the owner screen offers a repair.

## The office decides

Three decisions, in `domain/backorder.js`:

- **Confirm** — pending becomes confirmed. Still locked; it is coming.
- **Reject** — not being supplied. The lock is **released** so the crew can
  source it themselves, and they are told.
- **Return** — more information needed. Stays locked; the ball is with the crew.

**A partial return splits the request.** The confirmed part stays on the
original row; the returned remainder becomes a new row with `split_from_id`
pointing back. Miss this and quantities go wrong in a way that is very hard to
trace later.

**Re-raising a backorder answers a returned one** rather than opening a second
request — `planReturnedResubmission`, oldest first. Two open requests for the
same material would double the requirement.

## Notices are work, not log lines

A notice tells a crew what the office decided, on the line they raised it
from. It carries a quantity and is **settled by doing the thing**, not by
dismissing it:

- Locating material settles a **rejected** notice — they were told to find it,
  and did.
- Re-raising a backorder settles a **returned** one — the office asked a
  question, this is the answer.
- Issuing from stock settles **neither**. No instruction was carried out.

## Corrections never edit history

Someone keys 100 instead of 10. The fix is an **opposite entry**, never an
edit or a delete: the original transaction is what actually happened, and an
audit trail that can be rewritten is not one.

`applyCorrection` writes `CORRECTION_<TYPE>` transactions with negative
quantities and moves the ledger back. Preview first — this is the only place
quantities move without a physical event behind them. A reason is required and
kept, and the same transactions cannot be corrected twice (unique index on
`reversed_correlation_id`).

`validateCorrectedState` refuses any correction that would leave the line in a
state the schema forbids, with a message naming what would break.

## Roles

Four named permission sets in `domain/roles.js`. **`ADMIN` is not a superset of
`FIELD`** — deciding backorders at a desk is a different job from issuing pipe
in a warehouse, and conflating them was a real risk worth encoding.

A permission set matching no profile reports as `CUSTOM` and is preserved. The
original system silently coerced it to Read Only, so opening such a user and
saving stripped their access.

Guards, all server-side: the last active owner cannot be demoted or
deactivated, nobody can deactivate themselves, and deactivating needs a reason.

## Working on this

- **Rules go in `domain/`, which has no database import.** If a rule needs a
  query, the query goes in the service and the decision comes back to the
  domain. This is what keeps the tests fast and the rules readable.
- **Add tests to the existing files**, named as sentences about behaviour.
  `real-drawings.test.js` holds cases taken from actual drawings — every value
  in it broke something once.
- **Reach for `packages/core/test/schema-invariants.test.js`** when adding an
  action. Randomised sequences catch what examples miss.
- **Check the original** at `../FMRv3/FMRCoreV3` before assuming a rule is
  arbitrary. Most of them cost someone a bad day on site.
