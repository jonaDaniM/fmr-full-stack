# How to check every fix yourself

Fifteen things Jonathan raised. This is where to click for each one, what you
should see, and — where it matters — what should be *refused*.

Sign-in is by picking a name. Each section says which one, because several of
these are about who is allowed to do what.

**Setup**

```bash
cd fmr
./start-local.sh --reset      # http://localhost:3000
```

`--reset` gives you a clean database with five users. Use it the first time so
the roles below exist.

| Who | Role | Can |
|---|---|---|
| Jonathan D. | Owner | everything |
| Priya Raman | Planner | review and approve |
| Sam Okafor | Expeditor | backorders, assign FMR numbers, publish |
| Rita Alvarez | Warehouse | field work |
| Dale Hughes | Field | field work |

---

## 1. Nothing publishes without a planner and an FMR number

> *"FMR shouldn't be published without a FMR number that is created by someone
> from the Material team."*

This is four people's work in sequence. Do it in this order.

**As Jonathan** — Drafts → **New FMR**. Fill in drawing `D-9200`, sheet `01`,
and paste one material line:

```
PP-A106	2"	PIPE CS A106 GR B	100	FT
```

**Create draft**. Note there is no FMR number yet, and you were not asked for one.

Go to **Review**. The draft is there, marked **DRAFT**. Click **Send for
review**.

> **If it refuses**, read the message — it names what is missing, e.g. *"Fix 1
> problem before sending this for review: A drawing sheet is required."* That
> is the gate working.

**Sign out. Sign in as Priya Raman** (Planner).

Open **Review**. She sees three tabs only — *Everything waiting*, *With the
planner*, *Planner approved* — and two buttons: **Approve** and **Return for
correction**. She cannot number or publish anything.

Click **Approve**, then **Send to material management**.

**Sign out. Sign in as Sam Okafor** (Expeditor / material admin).

Open **Review**. The card reads **No number yet** and **WAITING FOR A NUMBER**.
His only action is **Give it its number**.

Click it, type `FMR-2026-9500`, **Assign and release**.

The card now reads **NUMBERED, READY TO PUBLISH** and **Numbered by Sam
Okafor** — and only now does a **Publish** button appear.

Click **Publish**, confirm.

**Check it reached the field:** go to **Field**, search `FMR-2026-9500`. The
line is there with 100 FT requested.

**What this proves:** a requisition cannot reach a crew until a planner has
approved it *and* a material admin has given it its number. Four screens, three
people, and the number comes from the material team — exactly as you described.

---

## 2. The FMR number is visible

> *"I don't see the FMR # in the Drafts or in the Office/Register page."*

**Drafts** — the number is the heading of every card. A draft without one says
*"(no number yet)"* rather than showing nothing.

**Office → Register** — **FMR** is the first column of the table.

---

## 3. Changing an FMR number is a material admin's job

> *"The option to change the FMR number shouldn't be so easily available."*

**As Sam Okafor or Dale Hughes** — Office → Register. Each row has **Open** and
nothing else.

**As Jonathan** — the same row now also has **Renumber**, which asks for the new
number *and why it is changing*, and keeps the history.

---

## 4. One drawing, several FMRs

> *"Construction crews install the pipe… weeks later they come back and install
> the valves, bolts and gaskets. We shouldn't block an FMR because that drawing
> has an existing FMR."*

Create two drafts with the **same drawing number** and **different FMR
numbers** — say `D-4410` as `FMR-A` and `FMR-B`. Both publish.

The duplicate check only ever matched on FMR number. It has never looked at the
drawing.

---

## 5. Add and remove lines while staging

> *"In the staging aspect we should have the option to add/delete lines."*

Import a workbook or drawing package. On the review screen:

- Each line has an **×**. Removing one **renumbers the rest** with no gap.
- Each FMR has **Remove**.
- Removing the **last line** on an FMR is refused — it tells you to remove the
  whole FMR instead, because an FMR with no material is not something a crew can
  be sent to find.
- Remove every FMR and it says **the batch was emptied** — not *"no FMRs were
  found in that file"*, which is what it used to say and which blamed your file.

Both removals are recorded.

---

## 6. Send it for review, or delete it

> *"An option to send it for review (Drafts page) / Delete that FMR (there are
> times when the planners are only working on certain parts of the package)."*

Both are on the Review screen: **Send for review** starts the chain, **Remove**
on the import screen drops what the planner is not working on yet.

---

## 7. A part-readable file is flagged, not rejected

> *"If the parser fails to extract part of the text we should highlight the line
> item and prompt the user to manually review — this is better than failing the
> entire program."*

Import a drawing package. Rows the extractor was unsure about arrive as
**warnings** naming the line, the reason, and the confidence score:

> *Line 4: the extractor was unsure — no size found (confidence 0.52).*

**Warnings do not block publishing. Errors do.** A line with no quantity is an
error, because nobody can go and find "some" of something.

Uploads that cannot be read at all now answer with the reason rather than a 500.

---

## 8. Material Takeoff

> *"I didn't see an option for MTO creation… that's the form the team uses to
> buy/order material."*

**Import** → below the drop zone, *"Or take material off for ordering"*.
Optionally give a CWA, choose your drawings, and the takeoff downloads.

Open it in Excel and check:

- **Pipe schedule** is filled from the drawing; pipe lines missing one are
  counted and flagged at the top
- Pipe and fittings, bolts and gaskets, and everything else are on **separate
  sheets** — different suppliers, different lead times
- Pipe is by the foot; a support reading `U-BOLT GUIDE FOR 2" PIPE` is
  **counted**, not measured
- Commodity codes stay text — Excel does not turn them into dates

---

## 9. Tuning the parser for a new project

> *"How will we fine tune the parser in new projects? Will I have to code the
> logic on the backend?"*

No code. Make a CSV whose headings the system has never seen:

```
Mark,Stock Code,NPD,Nomenclature,Req'd Qty,U/M
1,PP-A106-B,2 in,PIPE CS A106 GR B,120,FT
```

**Import** → **Tune it** → choose that file. Nothing is imported. You get:

- the row the headings were found on
- what it **recognised** (`U/M` → unit of measure)
- what is **missing**: *"Nothing is mapped to Description or Quantity. An import
  would produce no lines until that is fixed."*
- every unfamiliar heading with a dropdown **already set to the likely answer** —
  `Req'd Qty` → Quantity, `Nomenclature` → Description, `NPD` → Size

Correct anything wrong, name it *Midwest Expansion*, **Save layout**.

Now import the same file normally. **Before tuning it produced 0 lines and an
error; now it produces every line.**

The suggestion is never applied on its own — you confirm it. A reader that
quietly decides `QTY ORDERED` is the requested quantity will eventually decide
wrong, and a wrong quantity sends a crew after material nobody asked for.

Layouts belong to one project and cannot disturb another.

---

## 10. Line Swap — borrowing between lines

> *"The donor line is now short, and there is usually no clean record showing who
> borrowed the material, how much, or whether it was ever replaced."*

You need two FMRs with the **same commodity code, size and unit**: one holding
material, one short.

**As Dale Hughes** — Field → search the short FMR. The line offers **Borrow from
another line**.

The donor list shows FMR, line, **how much is on the shelf**, and the drawing.
Only unbagged material is offered — bagged stock is already promised to a crew.

Borrow 25. Then check both lines:

| | Before | After |
|---|---|---|
| Donor, on the shelf | 80 | 55 |
| Donor, **still to find** | 20 | **45** |
| Donor, **requested** | 100 | **100** |
| Receiver, issued | 0 | 25 |

**The donor's requirement does not shrink.** It goes back to looking short the
moment the material leaves — it never gets false credit for a requirement it
satisfied by giving material away. That is the whole point of the feature.

**As Sam Okafor** — Office → **Line swaps**, beside Backorders and Active bags.
The swap shows donor, receiver, material, borrowed, repaid, owed, and **age**.

**Record replacement** prefills the outstanding amount. Record part of it and
the swap stays open with the balance owed; record the balance and it leaves
*Still owed* but stays under **All**.

One thing to check deliberately: **recording a replacement does not put material
back on the donor's shelf.** It settles the obligation only. The crew still has
to locate it when the steel physically arrives — paperwork arriving is not steel
arriving.

**As Dale Hughes** — the **Office** tab is not in his navigation at all; he has
no business in the backorder or swap queues. If you reach `/admin.html`
directly and open Line swaps, it answers *"You do not have permission to do
that."* — the refusal is enforced by the server, not by hiding a link.

---

## 11. Where the takeoff sits in your order

Your four steps, against the system:

| Your step | Where |
|---|---|
| 1. Planners get ISOs → create the MTO | **Import → Material Takeoff** |
| 2. Sent out to quote | **Outside the system** — the future project |
| 3. Planner compiles work packages | Outside the system, as today |
| 4. Reviewed → FMRs → published | **Import → Review → the field** |

Steps 1 and 4 read the same drawings, so material is counted once and used
twice.

---

## What is deliberately not built

- **Automatic matching of deliveries to open swaps.** You flagged the risk
  yourself: the earlier Materials Tracker let one incoming quantity satisfy
  several swaps at full value. Repayment here is explicit and capped at what a
  swap owes.
- **Learning a layout from a file already imported correctly** — worth doing
  once the tuning screen shows what people actually get wrong.
- **FMR 209 line 9** still carries the duplicate backorder from the old system.
  Needs your decision before anything is removed.

---

## If something does not match this document

Tell me the section number and what you saw instead. Every step here was driven
through a browser, but on this machine and this data — yours may differ.
