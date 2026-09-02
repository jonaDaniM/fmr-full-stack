import hashlib
import re
from pathlib import Path
from typing import List, Optional, Sequence, Tuple

import fitz

from .fmr_model import IsoPage, QuarantineEntry
from .model import BomRow
from .pdf_parser import Word, _display_words, _join, _line_groups, parse_page
from .spool_model import spool_sort_key
from .spool_parser import extract_spool_markers


PIPE_RE = re.compile(r"^\s*PIPE(?:\s|$)", re.IGNORECASE)
IWP_VALUE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._()+/\-]*$")
IWP_BARE_VALUE_RE = re.compile(r"\b[A-Z]{2}-[A-Z0-9]+(?:-[A-Z0-9]+){1,}\b", re.IGNORECASE)
REVISION_RE = re.compile(r"^[A-Za-z0-9]+$")
SEVERE_ROW_NOTES = {
    "missing_description",
    "multiple_commodity_code_candidates",
    "multiple_quantity_candidates",
}

WELD_LOG_MARKERS = (
    "SECTION 15117",
    "FABRICATION OF METALLIC PIPE AND TUBING",
    "ATTACHMENT A - WELD/BRAZE LOG SHEET",
)

PIPE_SUPPORT_MARKERS = (
    "PIPE HANGERS AND SUPPORTS",
    "ATTACHMENT C",
)

ISO_WORKFLOW_STATUS_MARKERS = (
    "ISOSINPROCESSING",
    "ISOREVWORKFLOWSTATUS",
)

VIEW_ATTACHMENT_MARKERS = (
    "EAST SIDE",
    "LOOKING EAST",
    "LOOKING NORTH",
    "LOOKING SOUTH",
    "LOOKING WEST",
    "NORTH SIDE",
    "SOUTH SIDE",
    "WEST SIDE",
)


def normalize_text(text: str) -> str:
    return " ".join(text.upper().split())


def is_weld_log_page(text: str) -> bool:
    normalized = normalize_text(text)
    return all(marker in normalized for marker in WELD_LOG_MARKERS)


def is_pipe_support_page(text: str) -> bool:
    normalized = normalize_text(text)
    return all(marker in normalized for marker in PIPE_SUPPORT_MARKERS)


def is_fmr_attachment_page(text: str) -> bool:
    normalized = normalize_text(text)
    return "FIELD MATERIAL REQUEST" in normalized


def is_logistics_page(text: str) -> bool:
    return "LOGISTICS PLAN" in normalize_text(text)


def is_iso_workflow_status_page(text: str) -> bool:
    compact = normalize_text(text).replace(" ", "")
    return all(marker in compact for marker in ISO_WORKFLOW_STATUS_MARKERS)


def is_contextual_attachment_image_run(
    document: fitz.Document,
    page_index: int,
    page_texts: Sequence[str],
    max_run_length: int = 6,
) -> bool:
    """Recognize a short image-only run bracketed by approved attachments.

    Some packages place several adjacent 3D pipe-support views between native-
    text support sheets, or after the ISO pages and before weld logs. Each page
    in the run must contain exactly one image, and the run must either be
    bracketed by known support/weld pages or include a standard "LOOKING ..."
    view label. Unbracketed scans remain quarantined for OCR/review.
    """

    def is_sparse_single_image(index: int) -> bool:
        page = document[index]
        return (
            len((page_texts[index] or "").strip()) <= 80
            and len(page.get_images(full=True)) == 1
        )

    if not is_sparse_single_image(page_index):
        return False

    left = page_index
    while left > 0 and is_sparse_single_image(left - 1):
        left -= 1
    right = page_index
    while right + 1 < document.page_count and is_sparse_single_image(right + 1):
        right += 1
    if right - left + 1 > max_run_length:
        return False
    if left == 0 or right + 1 >= document.page_count:
        return False

    def is_view_run() -> bool:
        run_text = normalize_text(" ".join(page_texts[left:right + 1]))
        return any(marker in run_text for marker in VIEW_ATTACHMENT_MARKERS)

    def is_safe_neighbor(text: str) -> bool:
        return (
            is_pipe_support_page(text)
            or is_weld_log_page(text)
            or is_logistics_page(text)
            or is_fmr_attachment_page(text)
            or is_iso_page(text)
        )

    left_safe = is_safe_neighbor(page_texts[left - 1])
    right_safe = is_safe_neighbor(page_texts[right + 1])
    return left_safe and right_safe and (
        is_view_run()
        or is_pipe_support_page(page_texts[left - 1])
        or is_pipe_support_page(page_texts[right + 1])
    )


def is_iwp_cover_page(text: str) -> bool:
    # ISO title blocks often contain "Issued for Construction" and an IWP
    # reference.  The ISO/BOM structure is stronger evidence than those
    # generic construction-status phrases.
    if is_iso_page(text):
        return False
    normalized = normalize_text(text)
    has_cover_marker = (
        "INSTALLATION WORK PACKAGE" in normalized
        or "ISSUED TO CONSTRUCTION" in normalized
        or "ISSUED FOR CONSTRUCTION" in normalized
        or "JSAS FOR THIS IWP" in normalized
        or "JSA'S FOR THIS IWP" in normalized
        or "JSA FOR THIS IWP" in normalized
    )
    return (
        has_cover_marker
        and ("IWP NUMBER" in normalized or bool(IWP_BARE_VALUE_RE.search(text)))
    )


def is_iso_page(text: str) -> bool:
    normalized = normalize_text(text)
    return "ISOMETRIC DRAWING NUMBER" in normalized and "BILL OF MATERIALS" in normalized


def _phrase_line(words: Sequence[Word], phrase: Sequence[str]) -> Optional[List[Word]]:
    for line in _line_groups(words, tolerance=5.0):
        tokens = [w.text.upper().rstrip(":") for w in line]
        for start in range(0, len(tokens) - len(phrase) + 1):
            if tokens[start:start + len(phrase)] == list(phrase):
                return line
    return None


def extract_iwp_number(page: fitz.Page) -> Tuple[str, List[str]]:
    words = _display_words(page)
    candidates: List[str] = []
    for line in _line_groups(words, tolerance=5.0):
        for index in range(len(line) - 1):
            if line[index].text.upper().rstrip(":") != "IWP":
                continue
            if line[index + 1].text.upper().rstrip(":") != "NUMBER":
                continue
            value_words: List[Word] = []
            for word in line[index + 2:]:
                if word.text.upper().rstrip(":") == "IWP":
                    break
                value_words.append(word)
            candidate = "".join(w.text for w in value_words).strip()
            if candidate and IWP_VALUE_RE.match(candidate):
                candidates.append(candidate)
    if not candidates:
        candidates.extend(IWP_BARE_VALUE_RE.findall(page.get_text("text") or ""))
    unique = sorted(set(candidates))
    if len(unique) == 1:
        return unique[0], []
    if not unique:
        return "", ["iwp_number_not_detected"]
    return "", ["multiple_iwp_numbers_on_cover"]


def extract_iso_identity(page: fitz.Page) -> Tuple[str, str, List[str]]:
    words = _display_words(page)
    header_line = _phrase_line(words, ("ISOMETRIC", "DRAWING", "NUMBER"))
    if not header_line:
        return "", "", ["isometric_drawing_number_header_not_detected"]

    iso_header_words = []
    header_tokens = [w.text.upper().rstrip(":") for w in header_line]
    for start in range(len(header_tokens) - 2):
        if header_tokens[start:start + 3] == ["ISOMETRIC", "DRAWING", "NUMBER"]:
            iso_header_words = header_line[start:start + 3]
            break
    rev_headers = [
        w for w in header_line
        if w.text.upper().rstrip(":") == "REV" and w.x0 > iso_header_words[-1].x1
    ]
    if not rev_headers:
        return "", "", ["revision_header_not_detected"]
    rev_header = min(rev_headers, key=lambda w: w.x0)
    header_bottom = max(w.y1 for w in iso_header_words + [rev_header])

    iso_region = [
        w for w in words
        if header_bottom - 1 <= w.y0 <= header_bottom + 45
        and iso_header_words[0].x0 - 5 <= w.cx < rev_header.x0 - 4
    ]
    iso_lines = [line for line in _line_groups(iso_region, tolerance=4.0) if line]
    iso_lines.sort(key=lambda line: (abs(line[0].y0 - header_bottom), line[0].x0))
    drawing_number = ""
    if iso_lines:
        candidate = "".join(w.text for w in iso_lines[0]).strip()
        if candidate and " " not in candidate:
            drawing_number = candidate

    rev_region = [
        w for w in words
        if header_bottom - 1 <= w.y0 <= header_bottom + 45
        and rev_header.x0 - 8 <= w.cx <= rev_header.x1 + 32
        and REVISION_RE.match(w.text)
    ]
    rev_region.sort(key=lambda w: (abs(w.y0 - header_bottom), abs(w.cx - rev_header.cx)))
    revision = rev_region[0].text if rev_region else ""

    reasons: List[str] = []
    if not drawing_number:
        reasons.append("isometric_drawing_number_not_detected")
    if not revision:
        reasons.append("revision_not_detected")
    return drawing_number, revision, reasons


def is_pipe_material(row: BomRow) -> bool:
    return bool(PIPE_RE.match(row.description))


def _page_hash(drawing_number: str, revision: str, materials: Sequence[BomRow]) -> str:
    payload = [drawing_number.strip(), revision.strip()]
    payload.extend(
        "|".join((
            row.point_number.strip(), row.description.strip(), row.nominal_size.strip(),
            row.commodity_code.strip(), row.quantity.strip(),
        ))
        for row in materials
    )
    return hashlib.sha256("\n".join(payload).encode("utf-8")).hexdigest()


def parse_iso_page(
    page: fitz.Page,
    page_number: int,
    source_pdf: str,
    source_path: str,
    include_pipe: bool = True,
    pipe_only: bool = False,
    include_spool_numbers: bool = False,
    spool_numbers_only: bool = False,
) -> IsoPage:
    raw_text = page.get_text("text") or ""
    drawing_number, revision, reasons = extract_iso_identity(page)
    parsed = parse_page(page, page_number)
    if parsed.audit.get("status") != "ok":
        reasons.append(str(parsed.audit.get("reason") or parsed.audit.get("status")))

    retained: List[BomRow] = []
    point_numbers = set()
    for row in parsed.rows:
        pipe_material = is_pipe_material(row)
        if spool_numbers_only:
            continue
        if pipe_only and not pipe_material:
            continue
        if pipe_material and not include_pipe and not pipe_only:
            continue
        retained.append(row)
        if row.point_number in point_numbers:
            if "duplicate_bom_point_number" not in row.structural_notes:
                row.structural_notes.append("duplicate_bom_point_number")
        point_numbers.add(row.point_number)

    spool_numbers: List[str] = []
    spool_candidates = []
    if include_spool_numbers or spool_numbers_only:
        markers, spool_candidates = extract_spool_markers(page)
        spool_numbers = sorted(
            {marker.value for marker in markers}, key=spool_sort_key
        )

    return IsoPage(
        source_pdf=source_pdf,
        source_path=source_path,
        page=page_number,
        drawing_number=drawing_number,
        revision=revision,
        materials=retained,
        raw_text=raw_text,
        content_hash=_page_hash(drawing_number, revision, retained),
        review_reasons=sorted(set(reason for reason in reasons if reason)),
        spool_numbers=spool_numbers,
        spool_candidates=spool_candidates,
    )


def page_quarantine(
    pdf: Path,
    relative: str,
    page_number: int,
    reason_code: str,
    reason_detail: str,
    raw_text: str,
) -> QuarantineEntry:
    compact = " ".join(raw_text.split())[:1000]
    return QuarantineEntry(
        source_pdf=pdf.name,
        source_path=relative,
        page=page_number,
        reason_code=reason_code,
        reason_detail=reason_detail,
        raw_text=compact,
    )
