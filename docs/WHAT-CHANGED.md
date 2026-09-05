# What changed, and why

Written after your review of 3 September. Eight changes: three things you
asked for, four faults found while checking them, and one thing that turned
out not to be broken.

Nothing here changes how material moves. The ledger rules — located,
available, bagged, issued — are exactly as they were.

---

## What you asked for

### 1. Nobody can send material to a crew on their own

**Your rule:** *an FMR is not available for field execution until the Planner
has approved it, the Material Manager has assigned the official FMR number,
and the record is published.*

Before this, an FMR was either a draft or published, and anyone who could edit
a draft could publish it. There was no step in between.

Now there are two, owned by two different people:

```
created  →  with the planner  →  approved  →  waiting for a number
         →  numbered  →  published  →  the field can see it
```

- The **planner** checks the requisition suits the work package. They can
  approve it, or return it with a note saying what needs correcting.
- The **material manager** gives it the official FMR number and releases it.

Publishing is refused until both have happened. Trying it early says what is
missing rather than simply refusing:

> *FMR-2026-0417 is still with the planner. An FMR reaches the field once the
> planner has approved it and it has been given its number.*

A returned requisition goes **back into review** when it is corrected — it
cannot go round the planner.

**Two new roles.** *Planner* reviews packages and touches no material.
*Material Admin* now owns the FMR number, which is your second point:

> *the option to change the FMR number shouldn't be so easily available, it
> should be something that only a Material Admin can do.*

Existing people keep everything they had. Your material admins gain the
numbering; nobody loses anything.

**Every step is recorded** — who approved it, who numbered it, who published
it, and when. That was the one part of your audit list the system could not
answer before.

### 2. Material Takeoff

> *I didn't see an option for a MTO creation… this is vital because that's the
> form the team uses to buy/order material.*

Built. On the Import screen, below the drawing drop zone: choose the drawings,
optionally give a CWA, and you get the takeoff form back as a file.

It reads the same drawings the FMR import reads, so it costs no extra work.
What it adds is what a buyer needs and a warehouse does not:

- **Pipe schedule**, read off each drawing — you cannot order wall thickness
  without it. Pipe lines missing one are counted and flagged at the top of the
  file.
- **Split by how material is bought.** Pipe and fittings, bolts and gaskets,
  and everything else, on separate sheets — because they are quoted by
  different suppliers on different lead times.
- **Pipe by the foot, everything else counted.** A support whose description
  reads `U-BOLT GUIDE FOR 2" PIPE` names the pipe it holds; it is counted
  hardware, not 2 feet of pipe.

Run against your own `newFmr36` package: **26 drawings, 90 lines, 1.9 seconds.**

It comes out as CSV rather than a workbook. Your takeoff template varies by
project, and a CSV opens in Excel and pastes into whichever one is current.

### 3. Add and remove lines while staging

> *in the staging aspect we should have the option to add/delete lines… When
> viewing the FMRs that were extracted it would be useful to have an option to
> Delete that FMR (there is time where the planner are only planning on
> working on certain parts of the package).*

Both are there now, on the import review screen. Removing a line renumbers
what is left, because the numbering is what gets read back to the field.
Removing the last line on an FMR is refused — it points you at removing the
whole FMR instead, because an FMR with no material is not something a crew can
be sent to find.

Both are recorded. Material that stopped being requisitioned is a decision
worth being able to trace.

---

## What we found while checking

### 4. The numbering error that started all this

This is the important one.

At 5:57pm on 3 September you tried five times in ten seconds to give a draft
an FMR number, and got **"Something went wrong. Try again."** every time.

The rule being enforced was correct — another unpublished draft already held
that number. But the message was not: it was the generic one, and *try again*
is advice that could not work. Now:

> *FMR-2026-0417 already has a draft waiting. Publish or archive that one
> first, or give this draft a different number.*

**Two of the points in your review came from this one error.** It looked like
the system had no concept of FMR numbering, and like it was blocking a second
FMR on the same drawing. Neither was true — which brings us to the next part.

### 5. A package that could not be read now says what it held

Your `newFmr36` upload. We ran that exact file: it reads correctly — 26
drawings, the first on page 17, exactly as you noted. Pages 1–16 are a cover,
sixteen weld logs and six pipe-support sheets, and the extractor classifies and
skips them properly.

But a package with *no* readable drawings failed with *"No drawings were found
in those files"* — said of a file plainly full of drawings, which reads as a
broken parser. It now says what it did find:

> *No isometric drawings could be read from 1 file. 16 pages were set aside
> (weld logs, covers, or scans with no text behind them). A package of weld
> logs or scanned sheets has nothing to stage — check this is the drawing
> package, or upload the sheets on their own.*

**On your fail-safe point** — flagging uncertain rows for manual review rather
than failing the whole run — that was already built. Rows the parser is unsure
about are highlighted in the review table with the reason, and pages it sets
aside are reported on the batch. What was missing was only the all-or-nothing
case above.

### 6. Removing everything no longer blames the file

After removing the last FMR from a batch, the screen said *"No FMRs were found
in that file. Check it is the right one"* — about a file that read perfectly,
describing something you had just done deliberately. The counters above it
still showed the batch as staged.

Found by clicking the buttons rather than testing the endpoints. The rules were
right in both cases; only the screen was wrong.

### 7. Roles were being downgraded on the way out of the database

While testing the new roles: a Planner saved correctly but **read back as Read
Only**, and a Material Admin as a custom permission set. Saving such a person
again would have stripped their access.

Found and fixed before anyone used it. Every named role is now tested for a
full round trip, not just the two that broke — this is the second time a
permission set has been quietly downgraded on the way out.

---

## What turned out not to be broken

**One drawing can have several FMRs.** You wrote:

> *we shouldn't block an FMR because that drawing (ISO) has an existing FMR.*

It never did. The duplicate check matches on **FMR number only** — never on the
drawing. Your example works today: pipe and field welds now, valves and gaskets
months later, same drawing, different numbers, both publish. What you hit was
the numbering error in point 4.

**The FMR number is shown in Drafts and in the Register.** It is the first
column of the register, in bold, and the heading of every card in Drafts. If
you still cannot see it, send a screenshot — something specific is happening,
and it is not what it looks like.

**The FMR number is not assigned by the database.** You wrote that you liked it
being automatic. It is actually read off the drawing, and the screen says so:
*"This FMR is proposed as LP131-EMR-286013-04, after the drawing. Change it if
the office numbers these differently."* We have left that alone, because the
drawing number is what the field searches by — but if you want a database
sequence instead, that is a decision to make deliberately rather than a bug.

---

## Still open

**Line Swap / material borrowing.** Your proposal is sound and fits how the
system already works — it would become a seventh field action alongside Bag &
Tag and the rest, with its own queue beside Backorders. It is a real piece of
work, comparable in size to the backorder system, and needs quoting rather than
absorbing.

**Tuning the parser for a new project.** Today this means editing a file and
deploying. Your question — whether a user could give it examples instead — is a
good one and has no quick answer.

**FMR 209 line 9** still has the duplicate backorder from the old system, three
seconds apart. Needs your decision before anything is removed.

---

## How this was checked

Not by reading the code. Every change above was driven through a real browser:
signed in by clicking a name, navigated by clicking the menu, files chosen
through the file picker, buttons clicked where they actually sit on screen.

That is what found points 6 and 7 — in both cases the server was correct and
only the screen was wrong, which no amount of testing the server would have
shown.

- **394 automated tests**, run on every change
- The approval chain driven end to end in a browser, both roles
- Publishing tested from both sides: refused when unapproved, allowed when not
- The Material Takeoff run against your own 42MB package
- Your `newFmr36` file run through the extractor directly

**One thing to know before this goes live:** it adds two columns to the people
table and a status to the review queue. That runs as its own step before the
new version starts serving, and existing FMRs are marked published so nothing
in flight is disturbed.
