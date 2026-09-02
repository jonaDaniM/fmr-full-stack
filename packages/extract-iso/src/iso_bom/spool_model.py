from dataclasses import dataclass
from typing import Tuple


@dataclass(frozen=True)
class SpoolMarker:
    value: str
    bbox: Tuple[float, float, float, float]


@dataclass(frozen=True)
class SpoolCandidate:
    value: str
    bbox: Tuple[float, float, float, float]
    reason: str


def spool_sort_key(value: str) -> Tuple[int, int, str]:
    if value.isdigit():
        return int(value), len(value), value
    return 0, 0, value.casefold()
