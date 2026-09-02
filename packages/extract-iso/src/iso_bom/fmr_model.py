from dataclasses import asdict, dataclass, field
from typing import Dict, List, Tuple

from .model import BomRow
from .spool_model import SpoolCandidate


@dataclass
class IsoPage:
    source_pdf: str
    source_path: str
    page: int
    drawing_number: str
    revision: str
    materials: List[BomRow]
    raw_text: str
    content_hash: str
    review_reasons: List[str] = field(default_factory=list)
    spool_numbers: List[str] = field(default_factory=list)
    spool_candidates: List[SpoolCandidate] = field(default_factory=list)
    spool_review_reasons: List[str] = field(default_factory=list)

    @property
    def order_key(self) -> Tuple[str, int]:
        return self.source_path.lower(), self.page


@dataclass
class QuarantineEntry:
    source_pdf: str
    source_path: str
    page: int
    iwp_number: str = ""
    isometric_drawing_number: str = ""
    revision: str = ""
    reason_code: str = ""
    reason_detail: str = ""
    raw_text: str = ""

    def dict(self) -> Dict[str, object]:
        return asdict(self)


QUARANTINE_FIELDS = list(QuarantineEntry.__dataclass_fields__)


MATERIAL_REVIEW_NOTES = {
    "duplicate_bom_point_number",
    "missing_commodity_code",
    "missing_description",
    "missing_nominal_size",
    "missing_quantity",
    "multiple_commodity_code_candidates",
    "multiple_quantity_candidates",
}


def material_review_reasons(row: BomRow) -> List[str]:
    reasons = {
        note for note in row.structural_notes
        if note in MATERIAL_REVIEW_NOTES
    }
    for field_name, value in (
        ("description", row.description),
        ("nominal_size", row.nominal_size),
        ("commodity_code", row.commodity_code),
        ("quantity", row.quantity),
    ):
        if not str(value or "").strip():
            reasons.add(f"missing_{field_name}")
    return sorted(reasons)
