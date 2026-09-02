from dataclasses import asdict, dataclass, field
from typing import Dict, List, Optional, Tuple


@dataclass
class BomRow:
    point_number: str
    description: str
    nominal_size: str
    commodity_code: str
    quantity: str
    raw_text: str
    bbox: Tuple[float, float, float, float]
    structural_notes: List[str] = field(default_factory=list)


@dataclass
class Record:
    record_id: str
    category: str
    source_pdf: str
    source_path: str
    page: int
    point_number: str
    description: str
    nominal_size: str
    commodity_code: str
    quantity: str
    raw_text: str
    bbox_x0: float
    bbox_y0: float
    bbox_x1: float
    bbox_y1: float
    extraction_method: str
    ocr_derived: bool
    confidence: float
    status: str
    review_reasons: str

    def dict(self) -> Dict[str, object]:
        return asdict(self)

