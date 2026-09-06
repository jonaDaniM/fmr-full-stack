# Handoff — verifying FMR by hand

**For:** an assistant helping Reda click through the FMR app and confirm each
thing the client asked for actually works.

**Your job is not to write code.** It is to tell Reda where to click, what he
should see, and — where it matters — what should be *refused*. If something
does not match, find out why before changing anything.

---

## The project in one paragraph

FMR tracks material for industrial construction. Warehouse crews search for
material against a drawing, record what they found, bag it, issue it, or raise
a backorder when it is not there. The office decides those backorders. It
replaces a Google Apps Script system the client (Jonathan) ran for years.

Node + Postgres, no framework, no build step. `fmr/CLAUDE.md` has the
conventions; `fmr/ARCHITECTURE.md` has the schema.

---

## Starting it

```bash
cd "/Users/redaelhadfi/Desktop/app script/fmr"
./start-local.sh              # http://localhost:3000
./start-local.sh --reset      # wipe and reseed first
```

Sign in by clicking a name. **Which name matters** — several of these checks
are about who is allowed to do what, and doing everything as the owner hides
exactly what the approval chain is for.

| Who | Role | Can |
|---|---|---|
| Jonathan D. | Owner | everything |
| Priya Raman | Planner | review and approve; cannot number or publish |
| Sam Okafor | Expeditor | backorders, assign FMR numbers, publish |
| Rita Alvarez | Warehouse | field work |
| Dale Hughes | Field | field work only — no Office tab at all |

**Test file:** `~/Desktop/newFmr36/IP-SMM30R107MMPP-K447 combined.pdf` (40MB,
26 drawings). This is the client's own package — the one he could not upload.

---

## Clearing between runs

Uploading the same package twice makes every FMR collide with the one already
staged. That is correct behaviour, but it makes a fresh test confusing.

```bash
psql -tA fmr -c "BEGIN; DELETE FROM import_issues; DELETE FROM import_lines;
  DELETE FROM import_items; DELETE FROM import_batches; COMMIT;"
```

This clears staging only. Published FMRs and the ledger are untouched.

---

## What to verify, in order

### 1. The upload that failed for the client

> *"Failure experienced when uploading the input file from folder newFmr36.
> The first extractable page is file number 17."*

**Import → Choose files →** the 40MB PDF.

Expect **26 drawings, 90 lines**, about 90 seconds. Pages 1–16 are cover
sheets, weld logs and permits; the extractor skips them.

His uploads were 1–3MB — the file never reached the server. The limit on this
path is 100MB.

### 2. The fail-safe — flag the line, don't fail the run

> *"If the parser fails to extract part of the text we should highlight the
> line item and prompt the user to manually review."*

Look at the counter tiles: **Sheets · Lines · Errors · Blocked · Warnings**.

- **Warnings do not block publishing.** Uncertain rows are passed through for
  a person to check, with the reason and confidence named.
- **Errors do block.** A line with no quantity is an error, because nobody can
  go and find "some" of something.
- **Blocked** counts FMRs that cannot be published for a reason that is not a
  row error — usually a duplicate number.

On a clean run of `newFmr36` expect **0 Errors, 0 Blocked, 26 Warnings**, all
of them the same note: *"This FMR is proposed as LP131-…, after the drawing."*
That is the numbering note, not a parse failure.

### 3. Add and delete lines while staging

> *"In the staging aspect we should have the option to add/delete lines."*

On the review screen, pick a multi-line FMR such as `LP131-EMR-186013-04`.

- Each row has an **×**. Remove one and watch the **#** column — the rows
  below **renumber with no gap**. The field reads those numbers back.
- Remove down to the **last** line: it is **refused**, and points at removing
  the whole FMR instead.
- Each card has **Remove** for the whole FMR — for *"the planner is only
  working on certain parts of the package."*
- Remove **all 26**: it says **"the batch was emptied"**, not *"no FMRs were
  found in that file"*. The old message blamed the file for the user's action.

### 4. The FMR number is visible

> *"I don't see the FMR # in the Drafts or in the Office/Register page."*

- **Drafts** — the number is the heading of every card. Without one it reads
  *"(no number yet)"*.
- **Office → Register** — **FMR** is the first column.

### 5. Only a material admin changes a number

> *"The option to change the FMR number shouldn't be so easily available."*

- As **Sam Okafor** or **Dale Hughes** → Office → Register: each row has
  **Open** and nothing else.
- As **Jonathan** → the same row also has **Renumber**, which asks for the new
  number *and why it is changing*.

### 6. One drawing, several FMRs

> *"We shouldn't block an FMR because that drawing has an existing FMR."*

Create two drafts with the **same drawing number** and **different FMR
numbers**. Both publish. The duplicate check has only ever matched on FMR
number, never the drawing.

### 7. The approval chain — three people, four screens

This is the client's central requirement, and the only check needing three
sign-ins.

**As Jonathan** → Drafts → **New FMR**. Drawing `D-9200`, sheet `01`, and one
material line pasted in (tab-separated):

```
PP-A106	2"	PIPE CS A106 GR B	100	FT
```

**Create draft.** Note you were never asked for an FMR number.

⚠️ **Known rough edge:** the header errors on this form are stale until you
press **Save changes** — they are recorded when the draft is created and only
recompute on save. If it says a drawing number is required while one is
clearly typed, save first.

Then **Review → Send for review**.

**As Priya Raman** → Review shows **three tabs only** and two buttons:
**Approve** and **Return for correction**. She cannot number or publish.
Approve, then **Send to material management**.

**As Sam Okafor** → the card reads **No number yet / WAITING FOR A NUMBER**.
His only action is **Give it its number**. Assign one, and the card becomes
**NUMBERED, READY TO PUBLISH — Numbered by Sam Okafor**.

**Only now does a Publish button appear.** That pairing is the whole point.

**Check it landed:** Field → search the number. The line should be there.

### 8. Material Takeoff (MTO)

> *"I didn't see an option for a MTO creation… that's the form the team uses
> to buy/order material."*

**Import →** the *"Or take material off for ordering"* section below the drop
zone. Type CWA **`30R`** first, or that column comes out blank.

Same 26 drawings, ~2 seconds. Open the CSV and check:

- **Eight sheets**: COMBINED, BLINDS, PIPE & FITTINGS, BOLTS & GASKETS,
  SUPPORTS, VALVES, BIRDSCREENS, OTHER MATERIALS
- On `newFmr36`: COMBINED 90, PIPE & FITTINGS 39, SUPPORTS 49, VALVES 2,
  the rest empty. **OTHER MATERIALS must be empty** — anything there fell
  through the classification.
- **13 columns** ending EPIC PAINT CODE, CUST. PAINT CODE, COLOR
- Pipe is `LF`; every support is `EA`. A support reading
  `U-BOLT GUIDE FOR 2" PIPE` names the pipe it *holds* — it is counted
  hardware, not two feet of pipe. **This rule has broken twice.**

This output was verified row-for-row against the client's own CLI
(`Archive/`, `iso-mto-create`) on the same package: 90 rows, identical.

### 9. Line Swap — borrowing between lines

Needs two FMRs sharing commodity code, size and unit: one holding material,
one short.

**As Dale Hughes** → Field → search the short FMR → **Borrow from another
line**. Only unbagged material is offered; bagged stock belongs to a crew.

After borrowing 25, check the donor:

| | Before | After |
|---|---|---|
| Donor, on the shelf | 80 | 55 |
| Donor, **still to find** | 20 | **45** |
| Donor, **requested** | 100 | **100** |
| Receiver, issued | 0 | 25 |

**The donor's requirement must not shrink.** That is the accountability the
feature exists for.

**As Sam Okafor** → Office → **Line swaps** → **Record replacement**.
Recording a repayment **must not** put material back on the donor's shelf —
it settles the obligation only.

**As Dale** → the Office tab is not in his navigation. Going to
`/admin.html` directly answers *"You do not have permission to do that."*

### 10. Parser tuning

> *"Will I have to code the logic on the backend?"*

No. Make a CSV with headings the system has never seen:

```
Mark,Stock Code,NPD,Nomenclature,Req'd Qty,U/M
1,PP-A106-B,2 in,PIPE CS A106 GR B,120,FT
```

**Import → Tune it →** choose it. Nothing is imported. Each unfamiliar heading
gets a dropdown **already set to the likely answer**. Name the layout, save,
then import the same file normally: 0 lines before, all of them after.

---

## Rules for you, the assistant

**Verify before claiming.** Read the code or run the thing. Several bugs in
this project were found only by driving the UI — testing the endpoints alone
missed them.

**Never edit the ledger casually.** `located = available + bagged + issued` is
a CHECK constraint. Load the `fmr-domain` skill before touching quantities,
backorders, notices or corrections.

**Tests before commits:**

```bash
npm test                    # 357, no database needed
npm run test:db             # 64 more, needs FMR_TEST_DATABASE_URL
```

**No AI attribution in commit messages.** These commits ship to the client.

**Confirm before destructive commands.** Clearing staging is safe; anything
touching `fmr_lines`, `fmr_headers` or the deployment is not.

---

## Known rough edges (not yet fixed)

- **Stale header errors** in the Drafts form until you press Save changes.
- **The New FMR form can create an empty draft** if it posts before the typed
  values are read. It should refuse and say so.
- **CWA is blank** on the MTO unless typed in — the cover page rarely names
  one unambiguously. The client's own CLI refuses the package entirely for
  this; ours reads it and leaves the column empty.

---

## State of the work

**Nineteen commits ahead of the deployed revision.** Migrations `011`, `012`
and `013` must run against Cloud SQL **before** the new code serves —
publishing references `workflow_state`, and the review queue and import
profiles reference tables the deployed schema does not have.

**Do not deploy without Reda saying so.** The deployment carries the client's
real data: 837 FMRs, 5,706 lines, 22 users.

Still open with the client:

- **FMR 209 line 9** carries a duplicate backorder from the old system.
- Whether **PIPE SPEC** should hold the spec code (`315`, `332` — what his
  filled-in form shows, and what we match) or the schedule (`10S`, `40`).
- Automatic matching of deliveries to open line swaps.
