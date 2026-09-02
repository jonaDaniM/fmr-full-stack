import hashlib
import re
from typing import List, Optional, Sequence, Tuple

import fitz

from .fmr_parser import extract_iso_identity, is_pipe_material
from .model import BomRow
from .mto_model import (
    MTO_SCOPE_ALL_MATERIALS,
    MTO_SCOPE_BOLTS_GASKETS,
    MTO_SCOPE_COMBINED,
    MTO_SCOPES,
    MtoIsoPage,
    MtoMaterialRow,
)
from .pdf_parser import Word, _display_words, _join, _line_groups, parse_page


PIPE_SCHEDULE_VALUE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/\-]*$")
SHEET_RE = re.compile(r"-(\d{1,2})\s*$")
STANDARD_FITTING_RE = re.compile(
    r"^\s*(?:"
    r"ELL|ELBOW|TEE|RED|REDUCER|CONC\s+RED|ECC\s+RED|CAP|"
    r"COUPLING|COUP|CPLG|NIPPLE|NIP|FLG|FLANGE|OLET|"
    r"WELDOLET|SOCKOLET|THREDOLET|UNION|VALVE"
    r")(?:\b|[-,])",
    re.IGNORECASE,
)
CWA_STOP_TOKENS = {
    "DATE",
    "DISCIPLINE",
    "IWP",
    "NAME",
    "PURPOSE",
    "REV",
    "SCOPE",
    "SIGNATURE",
    "STAGE",
    "STATUS",
    "TITLE",
}
STANDALONE_BOLT_RE = re.compile(
    r"^\s*(?:STUD[ -]?BOLT|MACHINE[ -]?BOLT|ANCHOR[ -]?BOLT|"
    r"HEX[ -]?BOLT|CAP[ -]?SCREW)\b",
    re.IGNORECASE,
)
STANDALONE_GASKET_RE = re.compile(r"^\s*GASKETS?\b", re.IGNORECASE)
EARTHING_WASHER_RE = re.compile(r"^\s*EARTHING\s+WASHER\b", re.IGNORECASE)
SUPPORT_CODE_RE = re.compile(
    r"^5(?:UGSP|UG|US|MUGSP|MUG|FSS\d*|FS\d*|MHR\d*|ABS\d*|MS|CC|CI|C|G\d*)",
    re.IGNORECASE,
)
REVISION_SUFFIX_RE = re.compile(
    r"(?i)(\b\d+(?:\.\d+)?\s+in\.\s+Length)\s+\d{1,2}(?:/\d{1,2})?\s*$"
)
REVISION_BEFORE_LENGTH_RE = re.compile(
    r"(?i)(\s-\s)\d{1,2}\s+(?=\d+(?:\.\d+)\s+in\.\s+Length\s*$)"
)

# Dataset-validated procurement codes. Assembly gasket codes are intentionally
# absent so an unreadable assembly description cannot become a gasket row.
KNOWN_BOLT_CODE_RE = re.compile(
    r"^(?:5676576L\d*|5675648(?:L\d*)?|5675649|5675691)$",
    re.IGNORECASE,
)
KNOWN_WASHER_CODE_RE = re.compile(r"^5676235L\d*$", re.IGNORECASE)
KNOWN_GASKET_CODE_RE = re.compile(
    r"^(?:"
    r"5669399(?:L\d*)?|5669391(?:L\d*)?|5669359(?:L\d*)?|"
    r"5123470(?:L\d*)?|5664315|5672120L\d*|5495476|5669345|"
    r"5664556|5669711L\d*|5664355L\d*|5672150|5669761L0|5669363L\d*"
    r")$",
    re.IGNORECASE,
)
ALL_MATERIALS_PIPE_RE = re.compile(r"^\s*(?:\d{1,2}\s+)?PIPE(?:\s|$)", re.IGNORECASE)
PIPE_LENGTH_RE = re.compile(r"^(\d+(?:\.\d+)?)\s*'\s*$")
PIPET_RE = re.compile(r"^\s*PIPET(?:\s|$)", re.IGNORECASE)
LEADING_PIPE_REVISION_RE = re.compile(r"^\s*\d{1,2}\s+(?=PIPE(?:\s|$))", re.IGNORECASE)


def _clean_label(text: str) -> str:
    return text.upper().strip().rstrip(":")


def _line_after_label(line: Sequence[Word], label_index: int) -> str:
    value_words: List[Word] = []
    for word in line[label_index + 1:]:
        token = _clean_label(word.text)
        if token in CWA_STOP_TOKENS or word.text.endswith(":"):
            break
        value_words.append(word)
    return _join(value_words).strip()


def extract_cwa(page: fitz.Page) -> Tuple[str, List[str]]:
    candidates: List[str] = []
    for line in _line_groups(_display_words(page), tolerance=5.0):
        for index, word in enumerate(line):
            if _clean_label(word.text) != "CWA":
                continue
            candidate = _line_after_label(line, index)
            if candidate:
                candidates.append(candidate)
    unique = sorted(set(candidates))
    if len(unique) == 1:
        return unique[0], []
    if not unique:
        return "", ["cwa_not_detected"]
    return "", ["multiple_cwa_values_on_cover"]


def extract_pipe_schedule(page: fitz.Page) -> Tuple[str, List[str]]:
    for line in _line_groups(_display_words(page), tolerance=5.0):
        tokens = [_clean_label(word.text) for word in line]
        for index in range(len(tokens) - 1):
            if tokens[index:index + 2] != ["PIPE", "SCHEDULE"]:
                continue
            for word in line[index + 2:]:
                value = word.text.strip().rstrip(":")
                if PIPE_SCHEDULE_VALUE_RE.match(value):
                    return value, []
            return "", ["pipe_schedule_value_not_detected"]
    return "", ["pipe_schedule_not_detected"]


def sheet_number(drawing_number: str) -> Tuple[str, List[str]]:
    match = SHEET_RE.search(drawing_number or "")
    if not match:
        return "", ["sheet_number_not_detected"]
    return str(int(match.group(1))), []


def is_mto_material(row: BomRow) -> bool:
    description = clean_material_description(row.description)
    if ALL_MATERIALS_PIPE_RE.match(description):
        return False
    if classify_bolt_gasket(row.description, row.commodity_code):
        return False
    return not bool(STANDARD_FITTING_RE.match(description))


def clean_material_description(description: str) -> str:
    value = " ".join((description or "").split())
    value = LEADING_PIPE_REVISION_RE.sub("", value)
    value = re.sub(
        r"^SCOPE\s+(?=(?:STUD[ -]?BOLT|CAP[ -]?SCREW)\b)",
        "",
        value,
        flags=re.IGNORECASE,
    )
    value = REVISION_SUFFIX_RE.sub(r"\1", value)
    value = REVISION_BEFORE_LENGTH_RE.sub(r"\1", value)
    return " ".join(value.split())


def classify_bolt_gasket(description: str, commodity_code: str = "") -> Optional[str]:
    value = clean_material_description(description)
    if STANDALONE_BOLT_RE.match(value):
        return "BOLT"
    if STANDALONE_GASKET_RE.match(value):
        return "GASKET"
    if EARTHING_WASHER_RE.match(value):
        return "WASHER"
    code = (commodity_code or "").strip()
    if KNOWN_BOLT_CODE_RE.fullmatch(code):
        return "BOLT"
    if KNOWN_GASKET_CODE_RE.fullmatch(code):
        return "GASKET"
    if KNOWN_WASHER_CODE_RE.fullmatch(code):
        return "WASHER"
    return None


def is_bolt_gasket_material(row: BomRow) -> bool:
    return classify_bolt_gasket(row.description, row.commodity_code) is not None


def _partial_material(row: BomRow, item_type: str) -> MtoMaterialRow:
    notes = set(row.structural_notes)
    description = clean_material_description(row.description)
    commodity_code = row.commodity_code.strip()
    quantity = row.quantity.strip()
    partial_fields: List[str] = []

    if "multiple_commodity_code_candidates" in notes:
        commodity_code = ""
    if "multiple_quantity_candidates" in notes:
        quantity = ""

    fields = (
        ("description", description),
        ("size", row.nominal_size.strip()),
        ("commodity_code", commodity_code),
        ("quantity", quantity),
    )
    partial_fields.extend(name for name, value in fields if not value)
    return MtoMaterialRow(
        point_number=row.point_number,
        description=description,
        nominal_size=row.nominal_size.strip(),
        commodity_code=commodity_code,
        quantity=quantity,
        raw_text=row.raw_text,
        item_type=item_type,
        partial_fields=sorted(set(partial_fields)),
    )


def material_for_scope(row: BomRow, scope: str) -> Optional[MtoMaterialRow]:
    if scope not in MTO_SCOPES:
        raise ValueError(f"Unsupported MTO scope: {scope!r}")
    if scope == MTO_SCOPE_COMBINED:
        if not is_mto_material(row):
            return None
        item_type = "SUPPORT" if SUPPORT_CODE_RE.match(row.commodity_code or "") else "SPECIALTY"
        return _partial_material(row, item_type)

    if scope == MTO_SCOPE_ALL_MATERIALS:
        bolt_gasket_type = classify_bolt_gasket(
            row.description, row.commodity_code
        )
        if ALL_MATERIALS_PIPE_RE.match(row.description or ""):
            item_type = "PIPE"
        elif bolt_gasket_type:
            item_type = bolt_gasket_type
        elif STANDARD_FITTING_RE.match(row.description or "") or PIPET_RE.match(
            row.description or ""
        ):
            item_type = "FITTING"
        elif SUPPORT_CODE_RE.match(row.commodity_code or ""):
            item_type = "SUPPORT"
        else:
            item_type = "SPECIALTY"
        prepared = _partial_material(row, item_type)
        if item_type == "PIPE":
            prepared.uom = "LF"
            length = PIPE_LENGTH_RE.match(prepared.quantity)
            if length:
                prepared.quantity = length.group(1)
        return prepared

    prepared = _partial_material(row, "")
    item_type = classify_bolt_gasket(prepared.description, prepared.commodity_code)
    if not item_type:
        return None
    prepared.item_type = item_type
    return prepared


def _page_hash(
    drawing_number: str,
    revision: str,
    pipe_schedule: str,
    rows: Sequence[BomRow],
) -> str:
    payload = [drawing_number.strip(), revision.strip(), pipe_schedule.strip()]
    payload.extend(
        "|".join((
            row.point_number.strip(), row.description.strip(), row.nominal_size.strip(),
            row.commodity_code.strip(), row.quantity.strip(), row.raw_text.strip(),
        ))
        for row in rows
    )
    return hashlib.sha256("\n".join(payload).encode("utf-8")).hexdigest()


def parse_mto_iso_page(
    page: fitz.Page,
    page_number: int,
    source_pdf: str,
    source_path: str,
    scope: str = MTO_SCOPE_COMBINED,
) -> MtoIsoPage:
    if scope not in MTO_SCOPES:
        raise ValueError(f"Unsupported MTO scope: {scope!r}")
    raw_text = page.get_text("text") or ""
    drawing_number, revision, reasons = extract_iso_identity(page)
    pipe_schedule, _schedule_reasons = extract_pipe_schedule(page)
    sheet, _sheet_reasons = sheet_number(drawing_number)

    parsed = parse_page(page, page_number)
    retained: List[MtoMaterialRow] = []
    for row in parsed.rows:
        material = material_for_scope(row, scope)
        if material:
            retained.append(material)

    return MtoIsoPage(
        source_pdf=source_pdf,
        source_path=source_path,
        page=page_number,
        drawing_number=drawing_number,
        revision=revision,
        pipe_schedule=pipe_schedule,
        sheet_number=sheet,
        materials=retained,
        raw_text=raw_text,
        content_hash=_page_hash(drawing_number, revision, pipe_schedule, parsed.rows),
        review_reasons=sorted(set(reason for reason in reasons if reason)),
    )
