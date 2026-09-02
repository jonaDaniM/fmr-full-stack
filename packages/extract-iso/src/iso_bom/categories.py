from abc import ABC, abstractmethod
import re
from typing import Iterable


class CategoryExtractor(ABC):
    name: str

    @abstractmethod
    def matches(self, description: str) -> bool:
        raise NotImplementedError


class BoltExtractor(CategoryExtractor):
    name = "bolt"
    _pattern = re.compile(r"\b(?:STUD[ -]?BOLT|MACHINE[ -]?BOLT|ANCHOR[ -]?BOLT|CAP[ -]?SCREW|HEX[ -]?BOLT)\b", re.I)

    def matches(self, description: str) -> bool:
        # Deliberately excludes pipe-support U-BOLT entries.
        return bool(self._pattern.search(description))


class GasketExtractor(CategoryExtractor):
    name = "gasket"
    _pattern = re.compile(r"\bGASKET(?:S)?\b", re.I)

    def matches(self, description: str) -> bool:
        return bool(self._pattern.search(description))


DEFAULT_EXTRACTORS: Iterable[CategoryExtractor] = (BoltExtractor(), GasketExtractor())

