# FMR — QA test checklist

Paste into Notion. Each `[ ]` becomes a to-do; each `##` becomes a heading.

**How to run this.** Start the app with `npm run start:reset` (a clean database
with one seeded FMR), open http://localhost:3000 and sign in as **Jonathan D.**
unless a test names someone else. Work top to bottom — later tests depend on
material moved by earlier ones.

**Who's who in the seed data**

| Name | Role | Can |
|---|---|---|
| Jonathan D. | Owner | everything |
| Rita Alvarez | Warehouse | search, move material |
| Sam Okafor | Expeditor | search, decide backorders |
| Dale Hughes | Field | search, move material |

**Report a failure with:** what you clicked, what you expected, what happened,
and the FMR/line number. Screenshot if the wording is wrong.

---

## 1. Signing in

- [ ] The sign-in page lists the seeded users
- [ ] Signing in as Jonathan D. lands on a screen with Field, Office, Drafts, Import, Owner
- [ ] Signing in as Rita Alvarez shows fewer tabs — no Owner
- [ ] The project picker top-right switches between Gulf Coast and Midwest
- [ ] Signing out returns to the sign-in page
- [ ] Going straight to /admin.html while signed out sends you to sign-in

## 2. Searching (Field screen)

- [ ] Searching `FMR-2026-0417` returns 8 lines
- [ ] Searching `D-4410` returns every line on that drawing, both sheets
- [ ] Searching `D-4410|01` returns only sheet 01
- [ ] Searching `D-4410-01` returns the same as `D-4410|01` — **this is the shorthand crews type**
- [ ] Searching something that doesn't exist says so, rather than showing an empty table
- [ ] Each result shows requested / located / available / bagged / issued

## 3. The six field actions

Use **Rita Alvarez**. Line 1 of FMR-2026-0417 is 120 FT of 6" pipe, nothing located.

- [ ] **Confirm Available** 120 with a storage location → located 120, available 120
- [ ] Confirm Available again for 1 more → refused, message explains why
- [ ] Confirm Available for 121 on a fresh line → refused before you can submit
- [ ] **Issue from Available** 40 to Dale Hughes → issued 40, available 80
- [ ] Issue from Available more than is available → refused
- [ ] **Bag & Tag** 30 → bagged 30, available 50, and a tag number appears (BT-2026-00001)
- [ ] The tag number is on screen long enough to write on the bag
- [ ] **Issue from Bag** 10 from that tag → bagged 20, issued 50
- [ ] Issue from Bag more than the bag holds → refused
- [ ] **Locate & Issue** on an untouched line → located and issued in one move
- [ ] **Backorder** on a line with material missing → asks for a reason, won't submit without one
- [ ] After every action: located always equals available + bagged + issued

## 4. Quantity ceilings

- [ ] Every quantity box carries a maximum — you can't type more than the rule allows
- [ ] The maximum changes as you pick a different action
- [ ] A line fully issued offers no further actions
- [ ] Refusal messages are readable by a warehouse hand, not a developer

## 5. Backorders — the office side

Sign in as **Sam Okafor** or Jonathan. Office → Backorders.

- [ ] A backorder raised in the field appears in the queue as Pending
- [ ] The queue shows what the crew typed as the reason
- [ ] Status filters (Pending, Returned for Review, Confirmed, …) narrow the list
- [ ] **Confirm** the full quantity → status becomes Confirmed
- [ ] **Confirm** a partial quantity → status becomes Partially Confirmed
- [ ] **Reject** → asks to confirm first, then raises a notice for the crew
- [ ] **Return** → refuses without a note explaining what's needed
- [ ] **Return part of a request** → splits into two: a Returned one and a Pending one
- [ ] The returned half shows it came from the original request

## 6. Backorders — the field side

- [ ] A rejected backorder puts a notice on the crew's line: "source it on site"
- [ ] There is no way to dismiss a notice — the only way to clear it is to find the material
- [ ] Locating the material clears the notice
- [ ] A returned backorder shows the office's question on the crew's screen
- [ ] Re-raising it with more detail answers that request rather than opening a second one

> **Known limitation.** If the *whole* line is under a returned backorder, re-raising
> is refused with "Only 0 can be submitted…". The old system does exactly the same.
> Please note whether this happens in real work — it decides whether it gets fixed.

## 7. Pending backorders lock material

- [ ] On a line with a pending backorder, locating the locked quantity is refused
- [ ] The message says how much *can* be located
- [ ] Locating the unlocked remainder works
- [ ] Confirming the backorder then locating the material settles it — the backorder clears

## 8. Active bags (Office → Active bags)

- [ ] The tab lists every bag still holding material
- [ ] Each row shows tag, FMR, line, drawing, material, location, quantity, who bagged it, when
- [ ] Oldest bags are at the top
- [ ] **Find a bag without knowing its number** — search the material, e.g. "ELBOW"
- [ ] Search by storage location, e.g. "Rack 21"
- [ ] Search by FMR number
- [ ] "Ready for field" / "Partially issued" filters work
- [ ] Issue part of a bag → stays listed, marked Partially Issued, shows how much was drawn
- [ ] Issue the rest → leaves the list
- [ ] A bag sitting over 14 days is marked
- [ ] Signed in as Rita (warehouse), the Active bags tab is not available

## 9. The register (Office → Register)

- [ ] Lists every FMR with lines, requested, issued, remaining, progress
- [ ] **Search by FMR number**
- [ ] **Search by drawing** — and `D-5200-01` finds sheet 01
- [ ] **Search by work package (IWP)** — pick "Work package" in the dropdown
- [ ] **Search by who requested it**
- [ ] "Anything" mode finds all of the above
- [ ] Status and Priority filters
- [ ] "Show only" filter: Still outstanding / Not all found / On the shelf / Bagged not issued / Waiting on the office / On order
- [ ] Sort by: Last touched, Needed by, FMR number, Remaining, Progress, Requested
- [ ] The ↑↓ button reverses the order
- [ ] **Next / Previous** move through pages; the count reads "1–25 of 60"
- [ ] Previous is disabled on page 1; Next is disabled on the last page
- [ ] Changing a filter returns you to page 1
- [ ] The totals at the top describe *everything matching*, not just the page you're on
- [ ] "Clear" restores the full register
- [ ] A search matching nothing says so

## 10. Opening an FMR

- [ ] Clicking Open shows every line with its quantities
- [ ] **The notes the crew typed are on screen, under the material** — e.g. "Rack 12 empty, checked 14 as well"
- [ ] Each note says what was done, how much, by whom, and when
- [ ] A backorder note appears once, not twice
- [ ] A line nobody wrote on shows no notes, and nothing looks broken
- [ ] Bag tag numbers show against bagged quantities

## 11. By drawing

- [ ] Groups material by drawing sheet
- [ ] Shows what's outstanding per drawing
- [ ] A drawing spanning several FMRs is grouped together

## 12. Corrections (Owner)

- [ ] Owner → find a line someone has acted on
- [ ] Preview a correction — shows what will be reversed before anything happens
- [ ] Apply it → the quantity reverses on the ledger
- [ ] **The original entry is still in the history** — corrections add, never erase
- [ ] The correction shows who made it and why
- [ ] Rita (warehouse) cannot reach the Owner screen

## 13. Pausing work

- [ ] Owner → pause field work; a reason is required
- [ ] A crew trying to move material sees "Material movement is paused: <your reason>"
- [ ] The reason you typed is what they see
- [ ] Resume → work continues
- [ ] Pausing imports separately blocks importing but not field work

## 14. Users and permissions

- [ ] Owner → list of everyone with access, their role and permissions
- [ ] Add someone with a role
- [ ] Change someone's role
- [ ] Deactivate someone — a reason is required
- [ ] **You cannot deactivate yourself**
- [ ] **The last owner cannot be removed**
- [ ] A deactivated person cannot sign in
- [ ] Reactivate them → they can sign in again

## 15. Dropdown lists

- [ ] Owner → add a backorder reason
- [ ] It appears in the crew's backorder form
- [ ] Deactivate a value → gone from the form, still readable on old records

## 16. Renumbering an FMR

- [ ] Register → Renumber, with a reason
- [ ] The register shows the new number
- [ ] Everything recorded against it followed — lines, quantities, history
- [ ] A number already in use is refused

## 17. Import — spreadsheet

- [ ] Import → upload a CSV or Excel file
- [ ] Rows and columns are read correctly
- [ ] Sizes come through right: `3/4`, `1-1/2`, `6"`
- [ ] **A size Excel turned into a date (`4-Mar`) comes back as `3/4`**
- [ ] Quantities and units of measure are right
- [ ] Problem rows are flagged, not silently accepted
- [ ] Fix a flagged row in place
- [ ] Publish → the FMR appears in the register

## 18. Import — drawings

- [ ] Import → upload drawing PDFs
- [ ] Progress is shown while it reads
- [ ] Material comes out with drawing and page against each row
- [ ] Low-confidence rows are marked for review
- [ ] Rows needing a person don't publish automatically

## 19. Drafts

- [ ] Drafts lists everything waiting to be published
- [ ] Type an FMR by hand
- [ ] Edit the header and lines
- [ ] Delete a line
- [ ] A draft with errors won't publish, and says which errors
- [ ] Fix them → it publishes
- [ ] Archive a draft, with a reason
- [ ] Restore an archived draft

## 20. Two people at once

- [ ] Two browsers, two users, same line: both issue at once → totals are right, nothing double-counts
- [ ] One pauses work while the other is mid-action → the action is refused cleanly
- [ ] Double-clicking a submit button does not record it twice

## 21. On a phone

- [ ] Field screen is usable one-handed
- [ ] Quantity boxes bring up a number pad
- [ ] Buttons are big enough with gloves on
- [ ] Tables scroll sideways rather than breaking the layout
- [ ] Nothing important is off-screen

## 22. When things go wrong

- [ ] Losing the network mid-action shows a clear message, not a silent failure
- [ ] Refreshing does not repeat the last action
- [ ] Being signed out mid-task returns you to sign-in and back to where you were

## 23. The approval chain

Nothing reaches a crew until a planner has approved it and the material manager
has given it its number. Two people are needed: sign in as **Jonathan D.** to
create and to number, and give someone the **Planner** role to approve.

- [ ] Owner → Users shows **Planner** in the role list
- [ ] Saving someone as Planner, then reopening them, still shows **Planner** —
      not Read Only
- [ ] A Planner signing in sees a **Review** tab
- [ ] A Field User does not see Review
- [ ] A new draft appears in Review as **Draft** with "Send for review"
- [ ] A draft with a missing quantity refuses to be sent, and names the problem
- [ ] After sending, it reads **With the planner**
- [ ] The planner sees it; the material manager does not yet
- [ ] Approving asks first, then it reads **Planner approved**
- [ ] Returning it demands a note, and the note is shown on the card afterwards
- [ ] A returned draft, corrected and resubmitted, goes **back to the planner**
- [ ] After "Send to material management" it reads **Waiting for a number**
- [ ] The material manager sees it now; the planner does not
- [ ] A planner has no "Give it its number" button — **only Material Admin does**
- [ ] Assigning a number that is already published is refused, and says so
- [ ] After numbering it reads **Numbered, ready to publish**
- [ ] **Publishing an FMR that has not been through this is refused**, and the
      message says what is missing
- [ ] Publishing a numbered one works, and the field can then search it
- [ ] Owner → the FMR's history shows who approved it and who numbered it

## 24. Material takeoff

- [ ] Import shows "Or take material off for ordering" below the drop zone
- [ ] Choosing drawings downloads a file named `MTO <cwa>-<iwp>.csv`
- [ ] A CWA typed into the box appears in every row
- [ ] The file has three sheets: **PIPE & FITTINGS**, **BOLTS & GASKETS**,
      **COMBINED** — an empty one says so rather than looking broken
- [ ] Pipe is **LF** with no foot mark in the quantity; everything else is EA
- [ ] A support (`U-BOLT GUIDE FOR 2" PIPE`) is counted, **not** measured in feet
- [ ] The pipe schedule column is filled from the drawing
- [ ] Opening it in Excel keeps commodity codes as text — no dates

## 25. Removing staged material

- [ ] Each line in the import review has an × ; each FMR has **Remove**
- [ ] Removing a line asks first, and names the line
- [ ] Cancelling changes nothing
- [ ] After removing a line the ones below renumber with no gap
- [ ] Removing the last line on an FMR is refused, and says to remove the FMR
- [ ] Removing every FMR says **the batch was emptied** — not "no FMRs were
      found in that file"

## 26. Line swap — borrowing between lines

Needs two FMRs whose lines share a commodity code, size and unit: one holding
material on the shelf, one short.

- [ ] A short line offers **Borrow from another line**; a satisfied line does not
- [ ] The donor list shows the FMR, line, quantity on the shelf and drawing
- [ ] A line whose material nobody else holds says so, rather than opening an
      empty list
- [ ] A line with no commodity code explains that, rather than showing nothing
- [ ] Bagged material is **not** offered as borrowable
- [ ] After borrowing 25: the receiver shows 25 issued
- [ ] After borrowing 25: the donor's shelf falls by 25 **and its requested
      quantity is unchanged** — the shortfall reappears on the donor
- [ ] The donor's line status is no longer "Located"

In the office, **Line swaps** beside Backorders and Active bags:

- [ ] The swap appears, showing donor, receiver, material, borrowed and owed
- [ ] A field-only user cannot open this tab
- [ ] **Record replacement** prefills the outstanding amount
- [ ] Recording part of it leaves the swap open with the balance owed
- [ ] Recording the balance settles it and removes it from **Still owed**
- [ ] **All** still shows the settled swap
- [ ] Recording a replacement does **not** put material back on the donor's
      shelf — the crew still has to locate it
- [ ] The line's History shows the borrow on both lines

## 27. Tuning a workbook layout

Needs a workbook whose column headings differ from the baseline — for example
`Mark`, `Stock Code`, `NPD`, `Nomenclature`, `Req'd Qty`, `U/M`.

- [ ] The import screen shows a **Workbook layout** picker and **Tune it**
- [ ] Uploading the workbook under **Tune it** imports nothing
- [ ] The screen names the row the headings were found on
- [ ] Headings the reader knows are listed as recognised
- [ ] It says plainly when nothing is mapped to description or quantity
- [ ] Each unfamiliar heading has a dropdown, pre-filled with a sensible guess
      (`Req'd Qty` → quantity, `Nomenclature` → description, `NPD` → size)
- [ ] A heading can be left out
- [ ] Saving without a name is refused
- [ ] After saving, the layout appears in the picker marked *(this project)*
- [ ] Importing the same workbook with that layout now produces its lines
- [ ] The layout is still selected after a reload
- [ ] Saving under an existing name replaces it rather than making a second
- [ ] A layout saved on one project does not appear on another

---

## Sign-off

| | |
|---|---|
| Tested by | |
| Date | |
| Version / commit | |
| Passed | |
| Failed | |
| Blocking issues | |
