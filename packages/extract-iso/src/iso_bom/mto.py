"""Material Takeoff: the form the material team buys from.

An FMR asks the warehouse for material that has already been bought. An MTO
comes earlier — it is what the planner sends to the material manager and the
purchasing team so the material can be quoted and ordered in the first place.
Same drawings, same BOM rows, different question: the FMR asks "fetch this",
the MTO asks "buy this".

Because it is the same scan, this reads the pages the FMR extractor has
already classified and adds the two things the takeoff form needs and the
requisition does not:

  * **pipe schedule**, printed on the drawing, which the buyer needs to order
    the right wall thickness;
  * **item type**, so bolts and gaskets can be quoted separately from pipe and
    fittings — they are bought from different suppliers on different lead
    times, which is why the form has a sheet each.

The classification rules are ported from the MTO tool that produced the
takeoff workbooks this project was built against. They are not tidy, and they
are not guesses: each pattern is there because a real drawing wrote a material
that way.
"""

from __future__ import annotations

import re
from typing import Dict, List, Optional, Sequence

from .pdf_parser import _display_words, _join, _line_groups

# A schedule is short and alphanumeric — "40", "80", "10S", "315", "XS".
PIPE_SCHEDULE_VALUE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/\-]*$")

# The trailing "-04" of LP131-HHWR-1091320-04 is the sheet, not part of the
# line number. The MTO form keeps them in separate columns.
SHEET_RE = re.compile(r"-(\d{1,2})\s*$")

# Fittings a buyer orders from a fittings supplier.
STANDARD_FITTING_RE = re.compile(
    r"^\s*(?:"
    r"ELL|ELBOW|TEE|RED|REDUCER|CONC\s+RED|ECC\s+RED|CAP|"
    r"COUPLING|COUP|CPLG|NIPPLE|NIP|FLG|FLANGE|OLET|"
    r"WELDOLET|SOCKOLET|THREDOLET|UNION|VALVE"
    r")(?:\b|[-,])",
    re.IGNORECASE,
)

# Bolts and gaskets, which are quoted separately and arrive separately.
STANDALONE_BOLT_RE = re.compile(
    r"^\s*(?:STUD[ -]?BOLT|MACHINE[ -]?BOLT|ANCHOR[ -]?BOLT|"
    r"HEX[ -]?BOLT|CAP[ -]?SCREW)\b",
    re.IGNORECASE,
)
STANDALONE_GASKET_RE = re.compile(r"^\s*GASKETS?\b", re.IGNORECASE)

# Turner's support commodity codes all start 5-something. A support is counted
# hardware, never measured pipe, however much its description mentions pipe.
# Support and attachment codes. All of these are counted hardware whose
# description names the pipe they hold — "WELDED SHOE LONG, SS, 3" HIGH, 12"
# PIPE" is a shoe, not twelve inches of pipe. Reading one as pipe is the same
# fault that once sent 344 rows of hardware to be quoted by the foot, so the
# code is the authority and the description is never consulted.
#
# Every entry below appears in the client's own newFmr36 package.
SUPPORT_CODE_RE = re.compile(
    r"^5(?:UGSP|UG|US|MUGSP|MUG|FSS\d*|FS\d*|MHR\d*|ABS\d*|MS|CH|CC|CI|C"
    r"|SH|S\d|DA\d*|ISC|BG\d*|MG\d*|G\d*)",
    re.IGNORECASE,
)

# Actual pipe, which is bought by the foot rather than counted.
PIPE_RE = re.compile(r"^\s*PIPE\b", re.IGNORECASE)

# A pipe quantity carries a foot mark: 19.1'
PIPE_LENGTH_RE = re.compile(r"^\s*([\d.]+)\s*'?\s*$")

# Where a takeoff row goes on the form.
SHEET_BOLTS_GASKETS = "BOLTS & GASKETS"
SHEET_PIPE_FITTINGS = "PIPE & FITTINGS"
SHEET_COMBINED = "COMBINED"

CWA_STOP_TOKENS = {
    "DATE", "DISCIPLINE", "IWP", "NAME", "PURPOSE", "REV",
    "SCOPE", "SIGNATURE", "STAGE", "STATUS", "TITLE",
}


def _clean_label(text: str) -> str:
    return re.sub(r"[^A-Z]", "", (text or "").upper())


def pipe_schedule(page) -> str:
    """The schedule printed on the drawing, or "" when it is not there.

    The buyer cannot order pipe without it, so a blank is worth surfacing
    rather than filling in with a guess.
    """
    for line in _line_groups(_display_words(page), tolerance=5.0):
        tokens = [_clean_label(word.text) for word in line]
        for index in range(len(tokens) - 1):
            if tokens[index:index + 2] != ["PIPE", "SCHEDULE"]:
                continue
            for word in line[index + 2:]:
                value = word.text.strip().rstrip(":")
                if PIPE_SCHEDULE_VALUE_RE.match(value):
                    return value
            return ""
    return ""


def cwa(page) -> str:
    """The CWA (construction work area) from a package cover page.

    Only trusted when the cover names exactly one — a cover listing several is
    ambiguous, and the caller can supply the value instead.
    """
    candidates: List[str] = []
    for line in _line_groups(_display_words(page), tolerance=5.0):
        for index, word in enumerate(line):
            if _clean_label(word.text) != "CWA":
                continue
            rest = []
            for following in line[index + 1:]:
                if _clean_label(following.text) in CWA_STOP_TOKENS:
                    break
                if following.text.endswith(":"):
                    break
                rest.append(following)
            value = _join(rest).strip(": ").strip()
            if value:
                candidates.append(value)

    unique = sorted(set(candidates))
    return unique[0] if len(unique) == 1 else ""


def sheet_number(drawing_number: str) -> str:
    """The sheet, taken off the end of the drawing number."""
    match = SHEET_RE.search(drawing_number or "")
    return match.group(1) if match else ""


def line_number(drawing_number: str) -> str:
    """The drawing number without its sheet suffix."""
    return SHEET_RE.sub("", drawing_number or "").strip()


def item_type(description: str, commodity_code: str) -> str:
    """What kind of material this is, for the purpose of buying it.

    Order matters. A support whose description says "U-BOLT GUIDE FOR 2\" PIPE"
    names the pipe it holds, not pipe being bought — reading it as pipe once
    sent 344 rows of hardware to be quoted by the foot.
    """
    text = description or ""
    code = commodity_code or ""

    # Supports first, before anything reads their description as pipe.
    if SUPPORT_CODE_RE.match(code):
        return "SUPPORT"
    if STANDALONE_BOLT_RE.match(text):
        return "BOLT"
    if STANDALONE_GASKET_RE.match(text):
        return "GASKET"
    if PIPE_RE.match(text):
        return "PIPE"
    if STANDARD_FITTING_RE.match(text):
        return "FITTING"
    return "SPECIALTY"


def takeoff_sheet(kind: str) -> str:
    """Which sheet of the takeoff form a row belongs on."""
    if kind in ("BOLT", "GASKET"):
        return SHEET_BOLTS_GASKETS
    if kind in ("PIPE", "FITTING"):
        return SHEET_PIPE_FITTINGS
    return SHEET_COMBINED


def takeoff_row(material: Dict[str, object], drawing: Dict[str, object],
                package: Dict[str, object]) -> Dict[str, object]:
    """One row of the takeoff form, in the columns the form actually has."""
    kind = item_type(material.get("description"), material.get("commodityCode"))
    quantity = str(material.get("quantity") or "").strip()
    uom = "EA"

    # Pipe is bought by the foot, and the drawing writes it with a foot mark.
    if kind == "PIPE":
        uom = "LF"
        length = PIPE_LENGTH_RE.match(quantity)
        if length:
            quantity = length.group(1)

    drawing_number = str(drawing.get("drawingNumber") or "")
    return {
        "cwa": package.get("cwa") or "",
        "iwp": package.get("iwpNumber") or "",
        # The client's form carries the whole drawing number here, sheet
        # suffix included, and repeats the sheet in its own column. Stripping
        # the suffix produced a value their purchasing team does not recognise.
        "lineNumber": drawing_number or line_number(drawing_number),
        "sheet": sheet_number(drawing_number),
        "pipeSpec": drawing.get("pipeSchedule") or "",
        "description": material.get("description") or "",
        "size": material.get("nominalSize") or "",
        "commodityCode": material.get("commodityCode") or "",
        "quantity": quantity,
        "uom": uom,
        "itemType": kind,
        "takeoffSheet": takeoff_sheet(kind),
    }


def takeoff(payload: Dict[str, object], cwa_override: Optional[str] = None
            ) -> Dict[str, object]:
    """Every drawing in a scanned package, as takeoff rows.

    Takes the payload `fmr_json.scan` already produces, so reading a package
    for an MTO and reading it for FMRs is one pass over the same PDFs.
    """
    package = {
        "iwpNumber": payload.get("iwpNumber") or "",
        "cwa": (cwa_override or payload.get("cwa") or "").strip(),
    }

    rows: List[Dict[str, object]] = []
    for drawing in payload.get("drawings") or []:
        for material in drawing.get("materials") or []:
            rows.append(takeoff_row(material, drawing, package))

    counts: Dict[str, int] = {}
    for row in rows:
        counts[row["takeoffSheet"]] = counts.get(row["takeoffSheet"], 0) + 1

    return {
        "iwpNumber": package["iwpNumber"],
        "cwa": package["cwa"],
        "rows": rows,
        "counts": counts,
        "drawings": len(payload.get("drawings") or []),
        # A row the buyer cannot act on: no schedule to order pipe against.
        "missingPipeSpec": sum(
            1 for row in rows if row["itemType"] == "PIPE" and not row["pipeSpec"]
        ),
    }
