# FMR — what was fixed, and what we checked

**Reda El Hadfi** · 6 September 2026

This covers the two documents you sent: the feature review (staging, FMR
numbers, Line Swap, MTO, parser tuning) and the business process baseline.

Every point in both has been worked through against the running system, by
hand, screen by screen. Below is what changed and what was verified.

---

## 1. The things you reported

### The upload that failed

> *"Failure experienced when uploading the input file from folder newFmr36.
> The first extractable page is file number 17."*

Your 40 MB package now imports: **26 drawings, 90 material lines, no errors**.
Pages 1–16 are cover sheets, weld logs and permits, and the extractor walks
past them to the first real drawing.

The limit on that upload path is 100 MB. Your earlier attempts were 1–3 MB, so
the file was never reaching the server at all.

### The fail-safe

> *"If the parser fails to extract part of the text we should highlight the
> line item and prompt the user to manually review."*

This is how it now behaves:

- **Uncertain rows pass through, flagged.** They carry the reason and do not
  block publishing.
- **A line with no quantity is an error and blocks.** Nobody can be sent to
  find *some* of something.
- Both can sit on the same line. On one of our test rows the unreadable size
  was a warning and the missing quantity was an error — the row was shown for
  review and the publish was refused.

We found and fixed a gap here: a quantity **typed** into the review screen was
not re-checked. Clearing a cell stored a zero, nothing flagged it, and the
batch could be published with a line reading *find 0 ft of pipe*. Edited values
are now validated the same way imported ones are.

### Add and delete lines while staging

> *"In the staging aspect we should have the option to add/delete lines."*

- Removing a line **renumbers the rest with no gap** — the field reads those
  numbers off the printed sheet.
- Removing the **last** line is refused, and points at removing or archiving
  the whole FMR instead.
- Whole FMRs can be removed, for when the planner is only working part of a
  package. Every removal is recorded with the FMR number.

### The FMR number

> *"I don't see the FMR # in the Drafts or in the Office/Register page."*

- **Drafts** — the number is the heading of every card, or *(no number yet)*.
- **Office → Register** — FMR is the first column.

### Changing a number

> *"The option to change the FMR number shouldn't be so easily available — it
> should be something only a Material Admin can do."*

Renumber is visible only to an owner, and it asks for the new number **and why
it is changing**. Both go into the record.

Worth saying plainly: hiding the button is not the protection. The server
refuses the request independently, so someone who finds the URL or edits the
page in their browser still cannot do it. We tested that directly rather than
assuming it.

### One drawing, several FMRs

> *"Crews install the pipe, complete the field welds — weeks and sometimes
> months later they come back and install the valves, bolts and gaskets. So we
> shouldn't block an FMR because that drawing has an existing FMR."*

Two FMRs were created on drawing `D-9200` — one for pipe, elbow and flange, one
for the valve, gasket and stud bolts — taken separately through review,
numbering and publication. Both are live, and the crew searching `D-9200` sees
both.

Nothing about a shared drawing blocks anything. The duplicate check has only
ever matched on the FMR number.

---

## 2. Material Takeoff

> *"I didn't see an option for a MTO creation… that's the form the team uses to
> buy/order material."*

It is on the Import screen, below the drop zone. Same drawings, read for what
to order rather than what to fetch.

Checked row by row against the file itself, not by eye:

| | |
|---|---|
| Sheets | 8 — COMBINED, BLINDS, PIPE & FITTINGS, BOLTS & GASKETS, SUPPORTS, VALVES, BIRDSCREENS, OTHER MATERIALS |
| Rows | COMBINED 90 · PIPE & FITTINGS 39 · SUPPORTS 49 · VALVES 2 |
| OTHER MATERIALS | **empty** — nothing fell through the classification |
| Columns | 13, ending EPIC PAINT CODE, CUST. PAINT CODE, COLOR |
| Units | pipe `LF`, every support `EA` — **zero violations across all 90 rows** |

The unit rule matters and is easy to get wrong. A support reading
`U-BOLT GUIDE FOR 2" PIPE` names the pipe it *holds*; it is counted hardware,
not two feet of pipe. Every U-bolt, cradle, shoe and guide in the package came
out as `EA`.

Empty categories say *"(nothing on this package)"* rather than being left out,
so the buyer can see the category was considered.

---

## 3. Tuning the parser for a new project

> *"How will we fine tune the parser in new projects? Will I have to code the
> logic on the backend, or is there a way we can have the user input some
> examples?"*

No backend work. **Import → Tune it**, show it one of the project's own files,
and say what each unfamiliar heading holds.

We tested this on your own extractor output — 3,984 rows with headings the
system had never seen (`ident`, `npd`, `iso`, `no`, `qty`):

- Nothing is imported while tuning; it only reports what the reader can see.
- Familiar headings are recognised outright.
- Unfamiliar ones arrive with a dropdown **already set to the likely answer** —
  it suggested `npd → Size` and `ident → Commodity code` without being told.
- Save the layout, import the same file again: **commodity code and size went
  from blank on every row to populated on all 3,984**.

The system deliberately matches headings exactly rather than guessing. A fuzzy
match that reads `QTY ORDERED` as the requested quantity eventually reads one
wrong, and a wrong quantity sends a crew after material that is not there.

**One fix came out of this.** Both your files carry the drawing number as a
column repeated on every row, while the reader only looked for it as a label
above the table. It reported *"could not find isoNumber"* on a file that plainly
contained it. The reader now falls back to the table, and the tuning screen can
map the drawing number, sheet, FMR number and IWP number as well as the
material columns.

---

## 4. Line Swap

Built and checked against every point in your proposal.

### Borrowing

A field user searches the FMR they are trying to fulfil; a short line offers
**Borrow From Another Line**. Donors are matched on commodity code, size, unit
of measure and what is actually on the shelf.

- **Bagged material is never offered.** With 80 ft on the donor and 30 of it
  bagged, the borrow screen offered 50. Reserved material belongs to a crew.
- A line with no commodity code is never matched. Guessing from a description
  is how the wrong steel reaches a weld.
- You cannot borrow more than the donor holds.
- The borrow will not proceed without naming who is taking it.

### The accounting

This is the part that matters, and it holds:

| Donor, after lending 50 of its 80 | |
|---|---|
| Requested | **80 — unchanged** |
| Available | dropped |
| Still owed on the drawing | 80 |

**The donor gets no credit for material it gave away.** The receiving line is
credited with the material it received; the donor simply has less on the shelf
until replacement arrives. The shortage stays visible on the donor rather than
quietly moving to another ISO.

The physical issue and the replacement obligation are **two separate records**,
as your proposal asks.

### Repayment

- Partial repayment works — 20 against 50 left 30 owed.
- Over-repayment is refused, naming the amount actually outstanding.
- Full repayment closes the swap and drops it from the queue.
- **Repayment does not put material back on the donor's shelf.** It settles the
  obligation; the steel arrives through a normal receipt.

### The correctness risk you flagged

> *"…a correctness risk when one incoming quantity was allowed to satisfy
> multiple swaps without maintaining a shared remaining quantity."*

Tested directly. Two open swaps from the same donor, 15 each. A replacement of
10 recorded against one of them:

```
receiver A   borrowed 15   repaid 10   owed  5
receiver B   borrowed 15   repaid  0   owed 15
```

Each swap keeps its own remaining quantity. One delivery settles one
obligation.

### The queue

**Office → Line swaps**, beside Backorders. Shows open swaps, units owed,
aging, who lent, who received, and what is outstanding, filterable by whether
anything is still owed. Every borrow records the donor, receiver, quantity,
the user and the time.

---

## 5. The approval chain

Your business baseline describes: **Create → Planner review → Material Manager
numbers it → Publish → Field executes.** That is what the system does, and we
ran a requisition the whole way through with three different people signed in.

| Stage | What we saw |
|---|---|
| Draft | Created without an FMR number, as your document specifies |
| Planner | Approve and Return only — could not number or publish |
| Material Manager | *Waiting for a number* → assigned it |
| Publish | **Only appeared after the number existed** |
| Field | Searchable by drawing and by number |

The non-negotiables hold: a requisition cannot skip the planner, a planner
cannot assign the number, an approved request cannot be published without one,
and a returned or rejected request never becomes field-executable. Who
approved, who numbered, who published, and when, are all recorded.

**One change came from this.** The planner was being asked to judge whether a
requisition suited the work package while seeing only how many lines it had —
and the button offering the detail led to a screen her role cannot open. The
material is now listed on the review card itself, read-only. She decides;
correcting a line is the originator's job, which is what returning it is for.

---

## 6. Backorders and notices

- **Confirm** — the office commits to supplying it. Stays reserved.
- **Reject** — released, so the crew can source it themselves, and they are
  told so in as many words.
- **Return** — stays reserved, the question goes back to the crew with the
  office's own wording.
- **A partial decision splits the request.** Returning 20 of a 30 left 10 on
  the original and created a new linked record for the 20. Both remain
  visible with their own status.

Material under an open backorder cannot be located, reserved or issued while
the request is open, so a requirement is never counted twice — once as
material found and once as material on order.

Notices reach the crew as instructions rather than log entries:

> *"Rejected: 10 FT — The office will not be supplying this. Locate it from
> stock if you can."*

---

## 7. The ledger

Every field action was exercised — confirm found, bag, direct issue, issue from
available, issue from bag, backorder — and the ledger checked after each.

`located = available + bagged + issued` held on **every line, with no
exceptions**. Bagged material never reads as available to anyone else.

**Corrections never rewrite history.** Reversing an issue of 96 wrote an
opposite entry of −96 beside the original; both stand in the record. A reason
is required and kept, and the same transaction cannot be corrected twice — it
says when it was corrected and quotes the reason given.

---

## 8. Other fixes made along the way

Found while testing, all fixed and re-checked:

- **The draft editor opened the wrong FMR.** Clicking any card in a package
  opened the first one. A planner editing the fourteenth drawing was shown, and
  would have edited, the first.
- **Storage locations were being lost.** A line's location was stored but not
  sent back to the editor, and the blank cell would overwrite the real value on
  the next edit — material recorded with nowhere to find it.
- **Counters described the wrong thing.** Draft cards showed the whole batch's
  line count and error count, so every card in a 26-drawing package read
  *"90 lines"*, and one mistyped quantity marked all 26 as having errors.
  Batch totals were also never recomputed after a line or an FMR was removed.
- **Office screens rendered for field users.** The navigation does not offer
  them, but typing the address did. Data was refused in every case bar one —
  the office summary, which required only the permission every role has, and
  showed the backorder queue and crew movements. That is now restricted, and
  all four office screens refuse plainly instead of drawing controls that
  answer with errors.

---

## What was run

- **357 automated tests pass.** They cover the ledger rules, the approval
  chain, backorder decisions, swap arithmetic and the extraction rules, and
  run without a database.
- Everything above was also driven by hand through the real screens, with the
  database checked underneath each step. Several of these findings only appear
  that way — testing the endpoints alone would have missed them.

The database-backed test suite has not yet been run against these particular
changes; that is next, before anything is deployed.
