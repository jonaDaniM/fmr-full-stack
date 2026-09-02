from dataclasses import asdict, dataclass, field
from decimal import Decimal
from typing import Dict, List, Optional, Tuple

from .model import BomRow


@dataclass
class PipeMeasurement:
    row: BomRow
    linear_feet: Optional[Decimal]
    review_reasons: List[str] = field(default_factory=list)

    @property
    def precision(self) -> int:
        if self.linear_feet is None:
            return 1
        return max(1, -self.linear_feet.as_tuple().exponent)


@dataclass
class PipeIsoPage:
    source_pdf: str
    source_path: str
    page: int
    drawing_number: str
    revision: str
    pipe_measurements: List[PipeMeasurement]
    raw_text: str
    content_hash: str
    review_reasons: List[str] = field(default_factory=list)

    @property
    def order_key(self) -> Tuple[str, int]:
        return self.source_path.lower(), self.page

    @property
    def total_linear_feet(self) -> Optional[Decimal]:
        values = [item.linear_feet for item in self.pipe_measurements]
        if any(value is None for value in values):
            return None
        return sum((value for value in values if value is not None), Decimal("0"))

    @property
    def precision(self) -> int:
        return max((item.precision for item in self.pipe_measurements), default=1)


@dataclass
class PipeAuditRow:
    iwp_number: str
    source_pdf: str
    source_path: str
    page: int
    isometric_drawing_number: str
    revision: str
    point_number: str
    description: str
    nominal_size: str
    commodity_code: str
    quantity: str
    linear_feet: str
    raw_text: str
    bbox_x0: float
    bbox_y0: float
    bbox_x1: float
    bbox_y1: float
    status: str
    review_reasons: str

    def dict(self) -> Dict[str, object]:
        return asdict(self)


PIPE_AUDIT_FIELDS = list(PipeAuditRow.__dataclass_fields__)
