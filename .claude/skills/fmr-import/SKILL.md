---
name: fmr-import
description: How material gets into the system — reading drawing PDFs, normalising sizes and quantities, per-project extraction profiles, the drafts queue, and publishing. Load before changing anything in packages/import or packages/extract, before adding a project profile, or when an import is reading a value wrong.
---

# Getting material in

Three ways, all landing in the same place:

```
drawing PDFs  →  extract_materials.py  →  CSV  ─┐
FMR workbook  →  readWorkbook + extract.js  ────┼→  drafts queue  →  published
typed by hand →  drafts.js  ─────────────────────┘
```

**Nothing publishes automatically.** The drafts queue is where a person checks
the work before a crew is sent looking for anything.

## Normalisation is not guesswork

`packages/import/src/normalize.js` holds rules learned from real files. Every
one of these was a bug found against actual drawings — they are not
hypothetical, and the tests in `real-drawings.test.js` use the real values.

**Excel turns sizes into dates.** Opening a takeoff sheet converts `1/2"` to
`2-Jan` and `3/4"` to `4-Mar`. `fractionFromDateText` recovers them. The rule:
day greater than month means it was a fraction, because a fraction in lowest
terms always has a larger denominator.

**Four size formats, all real:**

| Written | Means |
|---|---|
| `1 1/2`, `1-1/2` | one and a half inches |
| `1.1/2` | the same — the PDF scraper writes a dot |
| `1.5` | the same again, as a decimal |
| `1X3/4`, `12X8` | a reducer: both bores, each normalised separately |

**Pipe quantities carry a foot mark** — `49.2'`. Before this was handled every
pipe line failed outright, and pipe is the most valuable material on a drawing.

**A foot mark outranks the description for unit of measure.** If the takeoff
wrote one, it measured it.

**Pipe supports are counted, not measured.** A description like
`U-BOLT GUIDE FOR 2" PIPE` names the pipe it *holds*. Reading "PIPE" and
ordering feet sent 344 rows of hardware to be measured in feet before this was
caught. Supports and fittings are counted; only actual pipe is measured.

## Reading a drawing PDF

`packages/extract/extract_materials.py`, Python with `pdfplumber`. Node has no
real equivalent, which is why this stage stays Python.

How it reads a page:

1. **Crop to the right of the sheet.** The bill of materials lives there; the
   drawing body would otherwise contribute hundreds of stray words.
2. **Cluster words into rows** by how close their tops are.
3. **Find the heading row** — `NO | NPD | DESCRIPTION | IDENT | QTY` — and take
   each column's left edge from it.
4. **Bucket each word by where it starts**, with boundaries halfway between
   headings.

That last step is what makes long descriptions behave: a description
overrunning its column is put back where it belongs rather than being read as a
part number. `split_ident` and `split_qty` do that.

Every row carries a **confidence** and the reasons it was reduced. Below 0.65
it goes to the review file, and the same reasons follow it into the drafts
queue so a reviewer sees exactly what was uncertain and why.

Over 989 real drawings: 6,055 rows, 99.5% above the threshold.

## Profiles are where variation lives

Drawings keep a similar shape between projects but never quite the same one.
Different drafting offices, different templates, different column wording.

**The engine is fixed; profiles hold the variation.** Adding a project means
writing a profile, not editing a parser.

- PDF side: `DEFAULT_PROFILE` in `extract_materials.py`, overridden with
  `--profile`. Controls crop position, the text that starts and ends the
  material list, column heading aliases, category sub-headings, and how a
  drawing number is read from a filename.
- Workbook side: `packages/import/profiles/*.json`. `default.json` is the
  baseline, `takeoff.json` matches the takeoff toolkit's output, and
  `extracted.json` reads the PDF extractor's CSV.

When an import reads something wrong, **the profile is almost always the fix**,
not the code.

## Saving is lenient, publishing is strict

One validator, `validateDraft`, with a `requireFmrNumber` flag.

Someone typing up a requisition can stop halfway and come back — gaps are
recorded against the draft rather than refused. Publishing re-validates from
stored state, so a stale flag cannot slip anything past.

The publish button asks the server (`checkDraftForPublish`) rather than reading
a stored count. The original system's button read a column and could disagree
with its own validation.

**Errors block publishing; warnings do not.** A line with no quantity is an
error: nobody can go and find "some" of something.

## Drafts

A manual FMR is a batch of one, sharing the import tables with a discriminator
(`import_batches.source`). One publish path, one review screen — where an FMR
came from stops mattering once it is waiting.

- **At most one unpublished draft per FMR number**, enforced by a partial
  unique index. The original checked this only on restore, so two fresh drafts
  could collide at publish instead.
- **Archiving is a status, never a delete.** Restoring keeps the same id and
  fails if another draft has taken its number meanwhile.
- Lines are edited in place. The original appended a new generation on every
  save because a spreadsheet cannot cheaply update a row; the audit log already
  carries the history.

## The takeoff toolkit

`industrial-iso-takeoff-toolkit/` is a separate Python tool that reads drawings
and produces workbooks. It installs as `iso-takeoff` and its BOM workflow is
the one that matters here:

```bash
iso-takeoff bom-fmr-generator --input ./drawings --output fmr.xlsx --iwp IWP-123
```

It exits 3 and reports `status: blocked_review` when it will not vouch for what
it read — ambiguous IWP, a page needing OCR, a revision conflict, an uncertain
cell. That is the same judgement the drafts queue exists to support, so the two
fit together without either having to change: the toolkit decides what is
trustworthy, and a person resolves the rest in drafts.

Its `BomItem` carries item, description, size, commodity, quantity, unit,
status, review_reason, and a source PDF and page — which maps onto
`import_lines` closely enough that wiring it in is mostly plumbing.

## XLSX parsing is deliberately not a dependency

The `xlsx` package on npm is unmaintained there and carries unfixed
prototype-pollution and ReDoS advisories. `workbook.js` takes a parser by
injection instead — install SheetJS from their own CDN, or a maintained
alternative, and call `setXlsxParser()`. CSV needs no parser.

Do not add `xlsx` back. `npm audit` is clean and should stay that way.
