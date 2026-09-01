#!/usr/bin/env python3
"""Extract material rows from isometric drawing PDFs.

Reads the bill of materials off ISO drawings and writes rows the FMR system
can import. Built on the approach in materialScrapper/scripts/
extract_instruments.py, widened from instruments to every material category,
and with the output shaped for the drafts queue rather than for a person to
read.

Drawings keep a similar shape between projects but never quite the same one,
so what varies lives in a profile (--profile), not in this file. Adding a
project means writing a profile.

Every row carries a confidence and the reasons it was reduced, so the review
screen can show a person exactly which rows to look at and why.

    python3 extract_materials.py --pdf-dir ./drawings --output-dir ./out
    python3 extract_materials.py --pdf-dir ./drawings --profile ./profiles/6820.json
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

try:
    import pdfplumber
except ImportError:
    sys.exit("pdfplumber is required: pip install pdfplumber")


# --- defaults, overridable by a project profile ----------------------------

DEFAULT_PROFILE: dict[str, Any] = {
    "name": "Baseline ISO drawing",

    # The BOM sits on the right of the sheet. Crop to it so the drawing body
    # does not contribute words.
    "crop_from_left": 0.68,
    "crop_fallback": 0.62,

    # Where the material list starts and stops.
    "section_start": r"\bOTHER\s+THAN\s+SHOP\s+MATERIALS\b",
    "section_stop": r"\bPIECE\s+MARKS\b",

    # Column headings, normalised to letters and digits only.
    "header_aliases": {
        "NO": "item_no", "ITEM": "item_no", "ITEMNO": "item_no",
        "NPD": "size", "SIZE": "size", "DIA": "size",
        "DESCRIPTION": "description", "DESC": "description",
        "IDENT": "ident", "IDENTNO": "ident", "COMMODITY": "ident",
        "COMMODITYCODE": "ident", "MATERIALCODE": "ident",
        "QTY": "qty", "QUANTITY": "qty",
        "REMARKS": "remarks", "REMARK": "remarks",
    },

    # Sub-headings inside the list. These group the rows; they are not rows.
    "category_headers": [
        "PIPE", "PIPING", "FITTINGS", "FLANGES", "VALVES", "GASKETS",
        "BOLTS", "BOLTING", "SUPPORTS", "PIPESUPPORTS", "HANGERS",
        "INSTRUMENTS", "INSTRUMENT", "INSTR", "MISC", "MISCELLANEOUS",
        "SPECIALTYITEMS", "SPECIALITEMS", "PAINT", "INSULATION",
        "OTHERTHANSHOPMATERIALS",
    ],

    # Lines that belong to the title block or the sheet furniture.
    "ignore_anchors": [
        "SHEET", "REVISION", "DRAWNBY", "CHECKEDBY", "APPROVED",
        "SCALE", "PROJECTNO", "CONTRACTNO", "WEIGHT", "PIECEMARKS",
    ],

    # A drawing number in the file name, so a row can be tied to its sheet.
    "iso_from_filename": r"^([A-Z0-9]+-[A-Z0-9]+-\d+-\d+)",

    "min_confidence": 0.65,
    "y_tolerance": 3.0,
}

# What a commodity code looks like. Projects number parts differently, so this
# covers the shapes seen so far: a support tag (PS-12), a long numeric ident
# (5368751), a catalogue code (C-ABC123), and the dash-segmented pattern used
# for pipe supports on Fluor drawings (5CH-02-50, 5UGSP-02-50, 5MS24-06).
IDENT_RE = re.compile(
    r"^(PS[\-A-Z0-9]*"
    r"|[A-Z]{0,3}\d{5,}[A-Z0-9]*"
    r"|C[A-Z0-9]{6,}"
    r"|\d[A-Z]{1,6}\d*(-[A-Z0-9]+)+"
    r"|\d[A-Z]{1,6}\d*[A-Z]?\d*[A-Z]?)$",
    re.I,
)

# A quantity may carry a foot mark — pipe is taken off by length, and 29.5'
# means 29.5 feet, not a stray apostrophe. Dropping it here would lose the
# measurement and read the row as having no quantity at all.
QTY_RE = re.compile(r"^\d+(\.\d+)?['′]?$")
ITEM_RE = re.compile(r"^\d{1,3}$")


def normalize(text: Any) -> str:
    """Letters and digits only, upper case — for comparing headings."""
    return re.sub(r"[^A-Z0-9]", "", str(text).upper())


# --- page model ------------------------------------------------------------

@dataclass
class Line:
    """One visual row of words, clustered by vertical position."""
    words: list[dict[str, Any]]

    @property
    def text(self) -> str:
        return " ".join(str(w["text"]).strip() for w in self.words).strip()

    @property
    def normalized(self) -> str:
        return normalize(self.text)

    @property
    def top(self) -> float:
        return min(float(w["top"]) for w in self.words)


@dataclass
class Row:
    """One material line, with why it should or should not be trusted."""
    source_pdf: str
    page_number: int
    iso_number: str = ""
    category: str = ""
    item_no: str = ""
    qty: str = ""
    size: str = ""
    description: str = ""
    ident: str = ""
    remarks: str = ""
    raw_text: str = ""
    warnings: list[str] = field(default_factory=list)
    wrapped: bool = False
    columns_uncertain: bool = False

    def finalize(self) -> dict[str, Any]:
        warnings = list(self.warnings)
        confidence = 1.0

        # Each deduction names something a person would have to check.
        if not self.qty:
            confidence -= 0.25
            warnings.append("no quantity")
        if not self.description:
            confidence -= 0.25
            warnings.append("no description")
        if not self.ident:
            confidence -= 0.10
            warnings.append("no commodity code")
        if not self.size:
            confidence -= 0.05
            warnings.append("no size")
        if self.columns_uncertain:
            confidence -= 0.15
            warnings.append("column positions uncertain")
        if self.wrapped:
            confidence -= 0.05
            warnings.append("row assembled from wrapped lines")
        if not self.category:
            confidence -= 0.10
            warnings.append("category unclear")

        return {
            "source_pdf": self.source_pdf,
            "page_number": self.page_number,
            "iso_number": self.iso_number,
            "category": self.category,
            "item_no": self.item_no,
            "commodity_code": self.ident,
            "size": self.size,
            "quantity": self.qty,
            "description": self.description,
            "remarks": self.remarks,
            "raw_text": self.raw_text,
            "confidence": max(0.0, min(1.0, round(confidence, 3))),
            "warnings": "; ".join(dict.fromkeys(warnings)),
        }


# --- geometry --------------------------------------------------------------

def cluster_lines(words: list[dict[str, Any]], y_tolerance: float) -> list[Line]:
    """Group words into visual rows by how close their tops are."""
    if not words:
        return []

    ordered = sorted(words, key=lambda w: (float(w["top"]), float(w["x0"])))
    lines: list[list[dict[str, Any]]] = [[ordered[0]]]
    current_top = float(ordered[0]["top"])

    for word in ordered[1:]:
        if abs(float(word["top"]) - current_top) <= y_tolerance:
            lines[-1].append(word)
        else:
            lines.append([word])
            current_top = float(word["top"])

    return [Line(sorted(group, key=lambda w: float(w["x0"]))) for group in lines]


def detect_columns(line: Line, aliases: dict[str, str]) -> dict[str, float]:
    """Find each column's left edge from the heading row.

    Headings are sometimes split across two words ("ITEM" "NO"), so a word is
    also tried joined to the one before it.
    """
    columns: dict[str, float] = {}
    previous = ""

    for word in line.words:
        raw = str(word["text"]).strip()
        name = aliases.get(normalize(raw)) or aliases.get(normalize(previous + raw))
        if name and name not in columns:
            columns[name] = float(word["x0"])
        previous = raw

    return columns


def column_ranges(columns: dict[str, float], page_width: float,
                  body: list["Line"] | None = None) -> dict[str, tuple[float, float]]:
    """Turn column left-edges into the span each column owns.

    A boundary sits halfway between two headings, which keeps a long
    description from spilling into the next column.

    That midpoint is wrong where a narrow heading sits over a wide column —
    "NO" above item numbers, with the description starting only a few
    millimetres to its right. The first word of a description then falls left
    of the midpoint and is read as part of the item number, and the row is
    discarded for having no item number at all. So where the rows themselves
    are available, prefer a boundary drawn through the widest gap between
    words that actually appears between the two headings.
    """
    ordered = sorted(columns.items(), key=lambda item: item[1])
    ranges: dict[str, tuple[float, float]] = {}

    def divide(left_x: float, right_x: float) -> float:
        midpoint = (left_x + right_x) / 2
        if not body:
            return midpoint

        # Word starts seen between the two headings, across every body row.
        starts = sorted({
            float(w["x0"]) for line in body for w in line.words
            if left_x <= float(w["x0"]) <= right_x
        })
        if len(starts) < 2:
            return midpoint

        # The widest gap between consecutive starts is the column rule.
        gap, at = max(
            ((b - a, (a + b) / 2) for a, b in zip(starts, starts[1:])),
            default=(0.0, midpoint)
        )
        # Only trust it when it is a real gap, not ordinary word spacing.
        return at if gap > 12 else midpoint

    for index, (name, x) in enumerate(ordered):
        left = 0.0 if index == 0 else divide(ordered[index - 1][1], x)
        right = page_width if index == len(ordered) - 1 else divide(x, ordered[index + 1][1])
        ranges[name] = (left, right)

    return ranges


def bucket(line: Line, ranges: dict[str, tuple[float, float]]) -> dict[str, str]:
    """Assign each word to a column by where it starts."""
    buckets: dict[str, list[str]] = {name: [] for name in ranges}

    for word in line.words:
        x = float(word["x0"])
        for name, (left, right) in ranges.items():
            if left <= x < right:
                buckets[name].append(str(word["text"]).strip())
                break

    return {name: " ".join(parts).strip() for name, parts in buckets.items()}


# --- page reading ----------------------------------------------------------


# An instrument is identified by its tag, not by a catalogue number: the loop
# letters are the ISA function codes (FT flow transmitter, PSV relief valve,
# and so on). Ported from materialScrapper/scripts/extract_instruments.py,
# which is where this list was worked out against real drawings.
INSTRUMENT_TAG_RE = re.compile(
    r"^(?:\d+-)?(?:PDT|PIT|PT|PI|LT|LI|LIT|LG|FT|FI|FIT|FE|TT|TI|TE|"
    r"XV|ZS|ZSC|ZSO|LSH|LSL|LS|PSV|PCV|FCV|LCV|TCV|FO|FV|LV|HV|TV|"
    r"PG|TG|LIC|PIC|TIC|FIC|SDV|MOV|AOV|PV|AE|PSE|TDV|VG)"
    r"-[A-Z0-9]+(?:-[A-Z0-9]+)*$",
    re.I,
)


def split_ident(cell: str) -> tuple[str, str]:
    """Separate a commodity code from description text sharing its column.

    Descriptions routinely overrun into the code column. Keeping only tokens
    that look like codes stops "Lbs, FF as C" being recorded as a part number.
    """
    tokens = [t for t in str(cell).split() if t]
    looks_like_code = lambda t: bool(IDENT_RE.match(t) or INSTRUMENT_TAG_RE.match(t))
    codes = [t for t in tokens if looks_like_code(t)]
    rest = [t for t in tokens if not looks_like_code(t)]
    return (codes[0] if codes else ""), " ".join(rest).strip()


def split_qty(cell: str) -> tuple[str, str]:
    """Separate a quantity from anything else in its column.

    The last number wins: a description ending in a dimension can leave a
    stray number to the left of the real quantity.
    """
    tokens = [t for t in str(cell).split() if t]
    numbers = [t for t in tokens if QTY_RE.match(t)]
    rest = [t for t in tokens if not QTY_RE.match(t)]
    return (numbers[-1] if numbers else ""), " ".join(rest).strip()


def is_category(line: Line, profile: dict[str, Any]) -> str | None:
    """A sub-heading inside the list, or None if this is a row."""
    norm = line.normalized
    if not norm or len(line.words) > 4:
        return None

    # A line carrying an item number and a quantity is a row, not a heading.
    tokens = [str(w["text"]).strip() for w in line.words]
    if any(ITEM_RE.match(t) for t in tokens[:2]) and any(QTY_RE.match(t) for t in tokens[-2:]):
        return None

    for header in profile["category_headers"]:
        if norm == header or norm.startswith(header):
            return line.text.strip()

    return None


def read_page(page: Any, profile: dict[str, Any], source_pdf: str,
              page_number: int, iso_number: str) -> tuple[list[Row], dict[str, Any]]:
    width, height = page.width, page.height
    audit = {"page": page_number, "rows": 0, "columns_found": False, "section_found": False}

    # The BOM is on the right of the sheet; cropping keeps drawing labels out.
    crop = page.crop((width * profile["crop_from_left"], 0, width, height))
    words = crop.extract_words(use_text_flow=False, keep_blank_chars=False)
    columns: dict[str, float] = {}
    lines: list[Line] = []

    start_re = re.compile(profile["section_start"], re.I)
    stop_re = re.compile(profile["section_stop"], re.I)
    ignore = profile["ignore_anchors"]

    for attempt in (profile["crop_from_left"], profile["crop_fallback"]):
        crop = page.crop((width * attempt, 0, width, height))
        words = crop.extract_words(use_text_flow=False, keep_blank_chars=False)
        if not words:
            continue

        lines = cluster_lines(words, profile["y_tolerance"])

        # Find the heading row *inside* the material section, not before it.
        # A drawing carries other tables — the revision block names NO,
        # DESCRIPTION and REV, which is enough aliases to be mistaken for the
        # BOM heading and would swallow the revision history as material.
        after_start = False
        for index, line in enumerate(lines):
            if not after_start:
                if start_re.search(line.text):
                    after_start = True
                continue
            if stop_re.search(line.text):
                break

            found = detect_columns(line, profile["header_aliases"])

            # Headings are often stacked over two rows — "PT" above "NO",
            # "NPD" above "(IN)" — so a single row names only some of the
            # columns and at the wrong x. Fold in the row above and the row
            # below, keeping the leftmost x for each column, which is where
            # the values actually start.
            if found:
                for neighbour in (index - 1, index + 1):
                    if not 0 <= neighbour < len(lines):
                        continue
                    for name, x in detect_columns(lines[neighbour], profile["header_aliases"]).items():
                        if name not in found or x < found[name]:
                            found[name] = x

            # A heading row names several columns at once.
            if len(found) >= 3:
                columns = found
                break

        if columns:
            break

    if not columns or not lines:
        return [], audit

    audit["columns_found"] = True

    # The rows between the heading and the end of the section, so the column
    # boundaries can be drawn where the data actually separates.
    body: list[Line] = []
    seen_start = False
    for line in lines:
        if not seen_start:
            if start_re.search(line.text):
                seen_start = True
            continue
        if stop_re.search(line.text):
            break
        body.append(line)

    ranges = column_ranges(columns, width, body)
    uncertain = len(columns) < 4

    rows: list[Row] = []
    current: Row | None = None
    category = ""
    started = False

    def flush() -> None:
        nonlocal current
        if current and (current.description or current.qty):
            rows.append(current)
        current = None

    for line in lines:
        text = line.text
        if not text:
            continue

        if not started:
            if start_re.search(text):
                started = True
                audit["section_found"] = True
            continue

        if stop_re.search(text):
            break

        norm = line.normalized
        if any(anchor in norm for anchor in ignore):
            continue

        # The heading row itself, repeated on continuation pages.
        if len(detect_columns(line, profile["header_aliases"])) >= 3:
            continue

        heading = is_category(line, profile)
        if heading:
            flush()
            category = heading
            continue

        cells = bucket(line, ranges)
        item = cells.get("item_no", "")

        if ITEM_RE.match(item):
            # A new item number starts a new row.
            flush()

            # A long description runs past its column, so whatever landed in
            # the code column that is not a code belongs to the description.
            ident_cell = cells.get("ident", "")
            description = cells.get("description", "")
            code, spill = split_ident(ident_cell)
            # Do not repeat the code in the description. An instrument row
            # carries its tag in both columns on some sheets, and printing it
            # twice makes the line read as if it were two different things.
            if spill and spill != code:
                description = f"{description} {spill}".strip()
            if code and description.strip() == code:
                description = ""

            # Likewise a quantity column holding something that is not a
            # number — usually a tag that drifted right.
            qty_cell = cells.get("qty", "")
            qty, qty_spill = split_qty(qty_cell)
            if qty_spill:
                description = f"{description} {qty_spill}".strip()

            current = Row(
                source_pdf=source_pdf,
                page_number=page_number,
                iso_number=iso_number,
                category=category,
                item_no=item,
                qty=qty,
                size=cells.get("size", ""),
                description=description,
                ident=code,
                remarks=cells.get("remarks", ""),
                raw_text=text,
                columns_uncertain=uncertain,
            )
        elif current and not item:
            # No item number: a wrapped continuation of the row above.
            extra = cells.get("description", "")
            if extra:
                current.description = f"{current.description} {extra}".strip()
                current.wrapped = True
            for name in ("size", "qty", "ident"):
                if not getattr(current, "ident" if name == "ident" else name) and cells.get(name):
                    setattr(current, "ident" if name == "ident" else name, cells[name])
            current.raw_text = f"{current.raw_text} | {text}"

    flush()
    audit["rows"] = len(rows)
    return rows, audit


def iso_from_name(filename: str, profile: dict[str, Any]) -> str:
    match = re.match(profile["iso_from_filename"], filename, re.I)
    return match.group(1).upper() if match else Path(filename).stem.upper()


def iso_from_page(page: Any, profile: dict[str, Any]) -> str:
    """Read the drawing number off the sheet itself.

    The file name is not reliable: a PDF often holds a whole work package, so
    its name is the IWP while every sheet inside it is a different drawing.

    A sheet names its neighbours too — "CONT. ON <drawing>" at each break, and
    the connecting drawings around the border — so simply taking the most
    frequent number is wrong. A sheet can reference one neighbour more often
    than itself, and then a whole page of someone else's material is filed
    under the wrong drawing.

    Position settles it. The drawing's own number is printed in the title
    block, at the bottom right of the sheet; the references are scattered
    through the drawing body. So prefer the match nearest the bottom-right
    corner, and fall back to frequency only when nothing sits there.
    """
    pattern = profile.get("iso_on_page")
    if not pattern:
        return ""

    compiled = re.compile(pattern, re.I)

    # Words that are a drawing number in their entirety, with where they sit.
    placed = [
        (w["text"].upper(), float(w["x0"]), float(w["top"]))
        for w in page.extract_words()
        if compiled.fullmatch(str(w["text"]))
    ]

    if placed:
        # The title block occupies the bottom right. Rank by how far into that
        # corner a match sits, measuring both axes as a fraction of the page.
        width, height = float(page.width), float(page.height)
        corner = profile.get("title_block", [0.55, 0.80])

        in_block = [
            (text, x, y) for text, x, y in placed
            if x >= width * corner[0] and y >= height * corner[1]
        ]
        if in_block:
            # Nearest the corner wins.
            return max(in_block, key=lambda item: item[1] + item[2])[0]

    # Nothing in the title block — fall back to the most repeated match.
    text = page.extract_text() or ""
    found = [value.upper() for value in compiled.findall(text)]
    if not found:
        return ""

    counts: dict[str, int] = {}
    for value in found:
        counts[value] = counts.get(value, 0) + 1
    return max(counts.items(), key=lambda kv: kv[1])[0]


def read_pdf(path: Path, profile: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    audit = {"pdf": path.name, "pages": 0, "rows": 0, "pages_with_material": 0}
    iso_number = iso_from_name(path.name, profile)

    try:
        with pdfplumber.open(path) as pdf:
            audit["pages"] = len(pdf.pages)
            for number, page in enumerate(pdf.pages, start=1):
                # Prefer the number printed on the sheet; fall back to the
                # file name when the drawing does not carry one.
                page_iso = iso_from_page(page, profile) or iso_number
                page_rows, page_audit = read_page(page, profile, path.name, number, page_iso)
                if page_rows:
                    audit["pages_with_material"] += 1
                rows.extend(row.finalize() for row in page_rows)
    except Exception as error:                      # a corrupt PDF is data, not a crash
        audit["error"] = f"{type(error).__name__}: {error}"

    audit["rows"] = len(rows)
    return rows, audit


# --- output ----------------------------------------------------------------

COLUMNS = [
    "source_pdf", "page_number", "iso_number", "category", "item_no",
    "commodity_code", "size", "quantity", "description", "remarks",
    "raw_text", "confidence", "warnings",
]


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=COLUMNS)
        writer.writeheader()
        writer.writerows(rows)


def load_profile(path: str | None) -> dict[str, Any]:
    profile = dict(DEFAULT_PROFILE)
    if path:
        profile.update(json.loads(Path(path).read_text(encoding="utf-8")))
    return profile


def run(pdf_dir: Path, output_dir: Path, profile: dict[str, Any],
        limit: int | None = None) -> dict[str, Any]:
    pdfs = sorted(p for p in pdf_dir.rglob("*.pdf") if not p.name.startswith("."))
    pdfs += sorted(p for p in pdf_dir.rglob("*.PDF") if not p.name.startswith("."))
    pdfs = sorted(set(pdfs))[:limit] if limit else sorted(set(pdfs))

    output_dir.mkdir(parents=True, exist_ok=True)

    all_rows: list[dict[str, Any]] = []
    audits: list[dict[str, Any]] = []

    for index, path in enumerate(pdfs, start=1):
        rows, audit = read_pdf(path, profile)
        all_rows.extend(rows)
        audits.append(audit)
        if index % 50 == 0:
            print(f"  {index}/{len(pdfs)} drawings, {len(all_rows)} rows")

    threshold = profile["min_confidence"]
    clean = [r for r in all_rows if r["confidence"] >= threshold]
    review = [r for r in all_rows if r["confidence"] < threshold]

    write_csv(output_dir / "materials.csv", all_rows)
    write_csv(output_dir / "materials_clean.csv", clean)
    write_csv(output_dir / "materials_review.csv", review)

    summary = {
        "profile": profile["name"],
        "drawings_scanned": len(pdfs),
        "drawings_with_material": sum(1 for a in audits if a["rows"]),
        "rows_total": len(all_rows),
        "rows_clean": len(clean),
        "rows_needing_review": len(review),
        "categories": sorted({r["category"] for r in all_rows if r["category"]}),
        "output_dir": str(output_dir),
    }

    (output_dir / "extraction_summary.json").write_text(
        json.dumps({"summary": summary, "drawings": audits}, indent=2),
        encoding="utf-8",
    )

    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--pdf-dir", required=True, help="Directory of drawing PDFs, searched recursively.")
    parser.add_argument("--output-dir", default="outputs", help="Where to write the CSVs and summary.")
    parser.add_argument("--profile", default=None, help="Project profile JSON. Omit for the baseline.")
    parser.add_argument("--limit", type=int, default=None, help="Stop after this many drawings.")
    args = parser.parse_args()

    profile = load_profile(args.profile)
    print(f"profile: {profile['name']}")

    summary = run(Path(args.pdf_dir), Path(args.output_dir), profile, args.limit)

    print()
    for key, value in summary.items():
        if key == "categories":
            print(f"  {key}: {', '.join(value) if value else '(none)'}")
        else:
            print(f"  {key}: {value}")


if __name__ == "__main__":
    main()
