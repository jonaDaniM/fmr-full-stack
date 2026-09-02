from dataclasses import dataclass, field
from typing import List, Tuple


MTO_SCOPE_COMBINED = "combined"
MTO_SCOPE_BOLTS_GASKETS = "bolts-gaskets"
MTO_SCOPE_ALL_MATERIALS = "all-materials"
MTO_SCOPES = (
    MTO_SCOPE_COMBINED,
    MTO_SCOPE_BOLTS_GASKETS,
    MTO_SCOPE_ALL_MATERIALS,
)


@dataclass
class MtoMaterialRow:
    point_number: str
    description: str
    nominal_size: str
    commodity_code: str
    quantity: str
    raw_text: str
    item_type: str
    uom: str = "EA"
    partial_fields: List[str] = field(default_factory=list)

    @property
    def is_partial(self) -> bool:
        return bool(self.partial_fields)


@dataclass
class MtoIsoPage:
    source_pdf: str
    source_path: str
    page: int
    drawing_number: str
    revision: str
    pipe_schedule: str
    sheet_number: str
    materials: List[MtoMaterialRow]
    raw_text: str
    content_hash: str
    review_reasons: List[str] = field(default_factory=list)

    @property
    def partial_row_count(self) -> int:
        metadata_partial = not self.pipe_schedule or not self.sheet_number
        return sum(
            1 for material in self.materials
            if metadata_partial or material.is_partial
        )

    @property
    def order_key(self) -> Tuple[str, int]:
        return self.source_path.lower(), self.page
