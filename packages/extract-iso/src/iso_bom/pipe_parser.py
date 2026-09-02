import hashlib
import re
from decimal import Decimal, InvalidOperation
from typing import List, Sequence

import fitz

from .fmr_parser import SEVERE_ROW_NOTES, extract_iso_identity, is_pipe_material
from .model import BomRow
from .pdf_parser import parse_page
from .pipe_model import PipeIsoPage, PipeMeasurement


LINEAR_FEET_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)(?:'|\u2032)\s*$")


def parse_linear_feet(value: str) -> Decimal:
    match = LINEAR_FEET_RE.fullmatch(value or "")
    if not match:
        raise ValueError(f"Pipe quantity is not a foot-marked number: {value!r}")
    try:
        return Decimal(match.group(1))
    except InvalidOperation as exc:
        raise ValueError(f"Pipe quantity is not a valid decimal: {value!r}") from exc


def _page_hash(drawing_number: str, revision: str, rows: Sequence[BomRow]) -> str:
    payload = [drawing_number.strip(), revision.strip()]
    payload.extend(
        "|".join((
            row.point_number.strip(), row.description.strip(), row.nominal_size.strip(),
            row.commodity_code.strip(), row.quantity.strip(), row.raw_text.strip(),
        ))
        for row in rows
    )
    return hashlib.sha256("\n".join(payload).encode("utf-8")).hexdigest()


def parse_pipe_iso_page(
    page: fitz.Page,
    page_number: int,
    source_pdf: str,
    source_path: str,
) -> PipeIsoPage:
    raw_text = page.get_text("text") or ""
    drawing_number, revision, reasons = extract_iso_identity(page)
    parsed = parse_page(page, page_number)
    if parsed.audit.get("status") != "ok":
        reasons.append(str(parsed.audit.get("reason") or parsed.audit.get("status")))

    point_numbers = set()
    measurements: List[PipeMeasurement] = []
    for row in parsed.rows:
        if row.point_number in point_numbers:
            reasons.append("duplicate_bom_point_number")
        point_numbers.add(row.point_number)

        severe_notes = sorted(set(row.structural_notes).intersection(SEVERE_ROW_NOTES))
        for note in severe_notes:
            reasons.append(f"point_{row.point_number}_{note}")

        if not is_pipe_material(row):
            continue

        row_reasons = [f"point_{row.point_number}_{note}" for note in severe_notes]
        feet = None
        try:
            feet = parse_linear_feet(row.quantity)
        except ValueError:
            row_reasons.append(f"point_{row.point_number}_invalid_pipe_quantity")
        measurements.append(PipeMeasurement(
            row=row,
            linear_feet=feet,
            review_reasons=sorted(set(row_reasons)),
        ))
        reasons.extend(row_reasons)

    return PipeIsoPage(
        source_pdf=source_pdf,
        source_path=source_path,
        page=page_number,
        drawing_number=drawing_number,
        revision=revision,
        pipe_measurements=measurements,
        raw_text=raw_text,
        content_hash=_page_hash(drawing_number, revision, parsed.rows),
        review_reasons=sorted(set(reason for reason in reasons if reason)),
    )
