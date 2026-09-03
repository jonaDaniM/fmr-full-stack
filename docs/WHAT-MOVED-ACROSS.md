# What moved across from the old system

The old FMR system was 64,000 lines of Google Apps Script sitting on a
spreadsheet. The new one is a database application. This is the plain account
of what came with it.

**Short version:** everything your crews and office actually do. Two things
were rebuilt because they were missing, one import route was replaced with
something better, and a handful of behind-the-scenes jobs are now the
database's responsibility instead of a script's.

Nothing here is claimed from reading code. Every line below was run against
the working system.

---

## Everything your people do, and where it is now

### The warehouse crew

| What they do | Status |
|---|---|
| Search by FMR number | ✅ Carried across |
| Search by drawing number and sheet | ✅ Carried across |
| Type `D-4410-01` and have it understood as sheet 01 | ✅ Carried across |
| Confirm Available — record what was found | ✅ Carried across |
| Bag & Tag — reserve material under a tag | ✅ Carried across |
| Bag tag numbers assigned automatically | ✅ Carried across |
| Issue from Available | ✅ Carried across |
| Issue from Bag | ✅ Carried across |
| Locate & Issue in one step | ✅ Carried across |
| Raise a backorder when material isn't there | ✅ Carried across |
| See the office's answer on their own screen | ✅ Carried across |
| Answer a returned request with more detail | ✅ Carried across |
| Quantity limits that stop over-issuing | ✅ Carried across |

### The office

| What they do | Status |
|---|---|
| Dashboard — what moved, what's waiting | ✅ Carried across |
| Backorder queue | ✅ Carried across |
| Confirm, reject, or return a backorder | ✅ Carried across |
| Return part of a request and split the rest | ✅ Carried across |
| **See bags packed but not yet issued** | ⭐ **Rebuilt — was missing** |
| The FMR register | ✅ Carried across |
| Search the register by FMR, drawing, work package or requester | ⭐ **Rebuilt — was missing** |
| Filter the register by what's outstanding, on the shelf, or stuck | ⭐ **Rebuilt — was missing** |
| Sort and page through the register | ⭐ **Rebuilt — was missing** |
| Open an FMR and see every line | ✅ Carried across |
| **See what the crew wrote against each line** | ⭐ **Rebuilt — was missing** |
| Progress grouped by drawing | ✅ Carried across |

### The owner

| What they do | Status |
|---|---|
| Correct a mistake without erasing history | ✅ Carried across |
| Add, change, or deactivate people | ✅ Carried across |
| Protection against removing the last owner | ✅ Carried across |
| Manage dropdown lists (backorder reasons, etc.) | ✅ Carried across |
| Pause all material movement, with a reason the crew sees | ✅ Carried across |
| Renumber a published FMR | ✅ Carried across |
| Search the ledger and review history | ✅ Carried across |
| System health check | ✅ Carried across |

### Getting material into the system

| What they do | Status |
|---|---|
| Upload a spreadsheet (Excel or CSV) | ✅ Carried across |
| Fix a bad row before publishing | ✅ Carried across |
| Sizes Excel mangled into dates (`3/4` → `4-Mar`) fixed automatically | ✅ Carried across |
| Quantity and unit normalisation | ✅ Carried across |
| Type an FMR by hand | ✅ Carried across |
| Review queue before anything goes live | ✅ Carried across |
| Archive and restore a draft | ✅ Carried across |
| Import direct from a Google Sheet | ⚠️ **Replaced** — see below |
| **Read material straight off drawing PDFs** | 🆕 **New — the old system couldn't** |

---

## The four things we rebuilt

These existed in the old system and were missing from the new one. They were
found by testing the running system against the old code, and all four are now
built and working.

**1. Field notes on the FMR drill-down.** Opening an FMR showed quantities but
not what the crew wrote. "Rack 12 empty, checked 14 as well" is the difference
between deciding a backorder blind and deciding it knowing where somebody has
already looked. The notes are now under each line.

**2. The active-bag list.** The office could see *how many* bags were sitting
unissued but not *which*. A bag packed and forgotten is material the field is
owed and cannot see. There is now a tab beside Backorders listing every one,
oldest first, searchable by material or location — so a bag can be found
without knowing its tag number. Bags sitting over two weeks are flagged.

**3. Searching the register.** The register listed every FMR with no way to
narrow it. It now searches by FMR number, drawing, **work package (IWP)** or
who requested it, filters by what's outstanding or stuck, sorts six ways, and
pages. The IWP search matters most — "show me everything for IWP-88-014" is a
question the old system answered and the new one couldn't.

**4. Two faults that would have surfaced on day one.** Pausing material
movement failed silently, and so did deactivating a user. Both looked correct
in the code and failed the moment they were actually run. Both are fixed, and
a check now runs with every build so the same class of fault can't return.

---

## What we deliberately left behind

Nothing here changes what your people can do.

**Google Sheets import.** The old system could pull from a Google Sheet.
The new one takes Excel and CSV uploads, and reads drawing PDFs directly —
which the old system could not do at all.
→ *If anyone still imports from a Sheet, tell us and we'll add it.*

**Drive backups and restore.** The old system copied the spreadsheet to Google
Drive on a schedule. The database now handles backup and point-in-time
recovery — continuous, not once a night.

**The nightly script.** It did two jobs: take a backup and run a health check.
Backups are automatic; the health check is a page you can open any time.

**About forty diagnostic tools.** Built to test the old system from inside
itself, and they wrote test data into the live spreadsheet to do it. Replaced
by 202 automated tests that run in under a second and never touch real data.

**The one-time spreadsheet migration engine.** Its job was moving your existing
data across. That runs once, at cutover, with a dry run first.

**A size-repair tool.** It fixed a specific old fault where Excel turned `3/4`
into a March-4 date and an earlier version rebuilt it backwards. The new system
fixes that at import, so the damage can't happen again.

---

## One thing to decide

**Answering a fully-returned backorder.** If the office returns a request that
covers an entire line, and the crew tries to answer it with more detail, the
system refuses.

**The old system does exactly the same thing** — this isn't something that
broke in the move. We've left it alone rather than change a rule without
asking.

The question for you: *does this come up in real work?* If crews hit it, we'll
fix it. If the office just reopens the request, it can stay as it is.

---

## How this was checked

Not by reading code. An earlier review did that and reported everything covered
— then testing found two features that crashed the moment they were used.

So every part of this was run against the working system: signed in as a real
user, actions performed through the same screens your crews use, and the ledger
read back afterwards to confirm the numbers landed correctly.

- Every screen and every button in the old system, catalogued and matched
- Every rule tested against the running application, not assumed
- The quantity rules checked across **10,363 possible states** — the old and
  new calculations agree exactly
- 202 automated tests, run on every change
- Both rebuilt screens confirmed in a real browser

**Still to do before go-live:** load your live spreadsheet. There's a dry run
that reports what would fail before anything is written. Expect some quantity
drift in data thirty people have been editing — better found now than at
cutover.
