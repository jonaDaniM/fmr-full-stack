# Drawing extraction

Reads the bill of materials off ISO drawing PDFs and writes rows the FMR
system can import.

```bash
python3 -m venv .venv && .venv/bin/pip install pdfplumber
.venv/bin/python extract_materials.py --pdf-dir ./drawings --output-dir ./out
```

Three CSVs come out: `materials.csv` (everything), `materials_clean.csv`
(confident rows), and `materials_review.csv` (rows a person should look at).
`extraction_summary.json` records what was scanned.

## How it reads a drawing

The bill of materials sits on the right of the sheet, so the page is cropped
before anything else — the drawing body contributes no words. Words are then
grouped into visual rows by how close their tops are, and each word is
assigned to a column by where it starts horizontally, with boundaries taken
halfway between the column headings.

That is what makes long descriptions behave: a description overrunning its
column is put back where it belongs rather than being read as a part number.

## Confidence

Every row carries a confidence and the reasons it was reduced — no quantity,
no description, uncertain column positions, assembled from wrapped lines.
Rows below 0.65 go to the review file rather than being thrown away, and the
same reasons follow the row into the FMR drafts queue, so whoever checks it
can see exactly what the extractor was unsure about.

Over 989 real drawings: 6,055 rows, 99.5% above the threshold.

## Per-project profiles

Drawings keep a similar shape between projects but never quite the same one.
What varies lives in a profile, not in the code:

```bash
.venv/bin/python extract_materials.py --pdf-dir ./drawings --profile ./profiles/6820.json
```

A profile can change where the BOM sits on the page, the text that starts and
ends the material list, the column headings and their aliases, the sub-headings
that group rows, and how a drawing number is read from a filename. Anything it
does not set falls back to the baseline in `DEFAULT_PROFILE`.

Adding a project means writing a profile.

## Into the FMR system

```bash
curl -X POST "$FMR/api/import/extracted?filename=materials.csv" \
     -H "x-project-id: $PROJECT" -b "$COOKIE" \
     --data-binary @out/materials.csv
```

Rows are grouped by drawing, so one run becomes one draft FMR per drawing.
Nothing is published — the drafts queue is where a person checks the
extractor's work before the crews ever see it.
