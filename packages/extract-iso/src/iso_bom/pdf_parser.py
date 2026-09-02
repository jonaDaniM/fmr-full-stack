import re
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

import fitz

from .model import BomRow


POINT_RE = re.compile(r"^[1-9]\d{0,2}$")
NUMBER_RE = re.compile(r"^\d+(?:\.\d+)?$")
QUANTITY_RE = re.compile(r"^\d+(?:\.\d+)?(?:['\u2032])?$")
COMMODITY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]*$")
HEADER_ALIASES = {
    "DESCRIPTION": "DESCRIPTION",
    "NPD": "NPD",
    "CMDTY": "CMDTY",
    "CMD1Y": "CMDTY",
    "QTY": "QTY",
    "Q1Y": "QTY",
}
FLOATING_NOTE_LINES = {
    "FIELD WELDS TO BE",
    "CUT AND BEVELED",
    "THREADED JOINTS ON THIS ISO ARE NOW SW",
    "VALVES AND INSTRUMENTS TO REMAIN THREADED",
}
TITLE_BLOCK_METADATA_RE = re.compile(
    r"^(?:\d{6}-\d+(?:-\d+)?|MOD-[A-Z0-9]+|SPEC\s+\d+)$"
)
NOMINAL_SIZE_VALUE_RE = re.compile(
    r"^(?:\d+(?:\s+\d+/\d+)?|\d+/\d+)"
    r"(?:X(?:\d+(?:\s+\d+/\d+)?|\d+/\d+))?$"
)
NOMINAL_SIZE_SUFFIX_RE = re.compile(
    r"^(?P<prefix>.+?)\s+"
    r"(?P<size>(?:\d+(?:\s+\d+/\d+)?|\d+/\d+)"
    r"(?:X(?:\d+(?:\s+\d+/\d+)?|\d+/\d+))?)$"
)
SUPPORT_PREFIX_RE = re.compile(r"^5[A-Z0-9-]+,")
SUPPORT_OCR_PREFIX_RE = re.compile(
    r"^S(?=(?:UGSP|UG|FSS\d*|FS\d*|MHR\d*|ABS\d*|MS|US|CC|CI|C|G\d*)"
    r"(?:[-,]|$))"
)
SUPPORT_CODE_PREFIX_RE = re.compile(
    r"^(5(?:UGSP|UG|FSS\d*|FS\d*|MHR\d*|ABS\d*|MS|US|CC|CI|C|G\d*))"
    r"(?:[-,]|$)"
)
SUPPORT_DESCRIPTION_MARKERS = (
    "SUPPORT",
    "U-BOLT",
    "GUIDE",
    "CRADLE",
    "CLAMP SHOE",
    "T-SHAPED",
)
LEADING_DIMENSION_ANNOTATION_RE = re.compile(
    r"^(?:\d+(?:/\d+)?\")\s+(?=5[A-Z0-9-]+,)"
)


@dataclass
class Word:
    x0: float
    y0: float
    x1: float
    y1: float
    text: str

    @property
    def cx(self) -> float:
        return (self.x0 + self.x1) / 2


@dataclass
class PageResult:
    rows: List[BomRow]
    audit: Dict[str, object]


def _display_words(page: fitz.Page) -> List[Word]:
    matrix = page.rotation_matrix
    result = []
    for raw in page.get_text("words"):
        rect = fitz.Rect(raw[:4]) * matrix
        result.append(Word(rect.x0, rect.y0, rect.x1, rect.y1, raw[4]))
    return result


def _find_header(words: Sequence[Word]) -> Optional[Dict[str, float]]:
    candidates = [w for w in words if w.text.upper() in HEADER_ALIASES]
    descs = [w for w in candidates if HEADER_ALIASES[w.text.upper()] == "DESCRIPTION"]
    for desc in sorted(descs, key=lambda w: (w.y0, -w.x0)):
        band = [w for w in candidates if abs(w.y0 - desc.y0) <= 22]
        found = {HEADER_ALIASES[w.text.upper()]: w.cx for w in band}
        if all(k in found for k in ("DESCRIPTION", "NPD", "CMDTY", "QTY")):
            pt_words = [w for w in words if w.text.upper() == "PT" and abs(w.y0 - desc.y0) <= 30 and w.cx < desc.cx]
            if pt_words:
                found["PT"] = max(pt_words, key=lambda w: w.cx).cx
                found["HEADER_Y"] = max(w.y1 for w in band)
                return found
    return None


def _line_groups(words: Iterable[Word], tolerance: float = 5.0) -> List[List[Word]]:
    lines: List[List[Word]] = []
    for word in sorted(words, key=lambda w: (w.y0, w.x0)):
        target = next((line for line in reversed(lines[-3:]) if abs(line[0].y0 - word.y0) <= tolerance), None)
        if target is None:
            lines.append([word])
        else:
            target.append(word)
    return [sorted(line, key=lambda w: w.x0) for line in lines]


def _join(words: Iterable[Word]) -> str:
    return " ".join(w.text for w in sorted(words, key=lambda w: (w.y0, w.x0))).strip()


def _normalized_line_text(words: Sequence[Word]) -> str:
    return " ".join(
        w.text.upper().strip(" ,.;:")
        for w in sorted(words, key=lambda w: w.x0)
    )


def _is_floating_note_line(words: Sequence[Word]) -> bool:
    return _normalized_line_text(words) in FLOATING_NOTE_LINES


def _is_revision_history_line(words: Sequence[Word]) -> bool:
    return "ISSUED FOR CONSTRUCTION" in _normalized_line_text(words)


def _is_title_block_metadata_line(words: Sequence[Word]) -> bool:
    return bool(TITLE_BLOCK_METADATA_RE.fullmatch(_normalized_line_text(words)))


def _has_material_start_evidence(
    words: Sequence[Word],
    point_word: Word,
    bounds: Sequence[float],
) -> bool:
    has_code_or_quantity = False
    for word in words:
        if word is point_word:
            continue
        if word.cx < bounds[0]:
            if POINT_RE.match(word.text):
                continue
        elif word.cx < bounds[1]:
            continue
        elif word.cx < bounds[2]:
            continue
        else:
            has_code_or_quantity = True
    return has_code_or_quantity


def _is_numeric_wrap_artifact_line(
    words: Sequence[Word],
    bounds: Sequence[float],
) -> bool:
    if not words:
        return False
    if any(bounds[0] <= word.cx < bounds[1] for word in words):
        return False
    if any(word.cx >= bounds[2] for word in words):
        return False
    has_point_column_number = any(
        word.cx < bounds[0] and POINT_RE.match(word.text)
        for word in words
    )
    if not has_point_column_number:
        return False
    return all(
        NUMBER_RE.match(word.text) or NOMINAL_SIZE_VALUE_RE.fullmatch(word.text)
        for word in words
    )


def _clean_material_line(words: Sequence[Word], bounds: Sequence[float]) -> List[Word]:
    if _is_numeric_wrap_artifact_line(words, bounds):
        return []
    has_code_or_quantity = any(word.cx >= bounds[2] for word in words)
    desc_words = [
        word for word in words
        if bounds[0] - 12.0 <= word.cx < bounds[1]
    ]
    has_description_continuation = any(
        not NUMBER_RE.match(word.text) for word in desc_words
    )
    if not desc_words or has_code_or_quantity or not has_description_continuation:
        return list(words)

    cleaned: List[Word] = []
    for word in words:
        if bounds[1] <= word.cx < bounds[2] and (
            NUMBER_RE.match(word.text)
            or NOMINAL_SIZE_VALUE_RE.fullmatch(word.text)
        ):
            continue
        if (
            bounds[0] - 2.0 <= word.cx < bounds[0] + 12.0
            and POINT_RE.match(word.text)
        ):
            continue
        cleaned.append(word)
    return cleaned


def _insert_before_phrase(text: str, value: str, phrase: str) -> str:
    if phrase not in text or f"{value} {phrase}" in text:
        return text
    return text.replace(phrase, f"{value} {phrase}", 1)


def _move_size_prefix_to_description(description: str, size: str) -> Tuple[str, str]:
    description = LEADING_DIMENSION_ANNOTATION_RE.sub("", description).strip()
    if SUPPORT_PREFIX_RE.match(description):
        description = re.sub(r"\s+\d{5,6}$", "", description).strip()
    if not size or NOMINAL_SIZE_VALUE_RE.fullmatch(size):
        return description, size

    match = NOMINAL_SIZE_SUFFIX_RE.fullmatch(size)
    if not match:
        return description, size
    prefix = match.group("prefix").strip()
    normalized_size = match.group("size").strip()
    if not prefix:
        return description, normalized_size

    if prefix == "PIPE":
        if "FOR SIZE" in description:
            description = description.replace("FOR SIZE", "FOR PIPE SIZE", 1)
        elif " PIPE " not in f" {description} ":
            description = f"{description} PIPE"
    elif prefix == "NPD":
        if " NPD" not in f" {description}":
            description = f"{description} NPD"
    elif prefix == "SCR":
        pass
    elif prefix in {"FNPT", "SW", "SW/SCRD", "MTE/FTE"}:
        if f" {prefix} " not in f" {description} ":
            description = f"{description} {prefix}"
    elif prefix.endswith('"'):
        if "AND SMALLER PIPE" in description:
            description = _insert_before_phrase(
                description, prefix, "AND SMALLER PIPE"
            )
        elif "NPD" in description:
            description = _insert_before_phrase(description, prefix, "NPD")
        elif prefix not in description:
            description = f"{description} {prefix}"
    else:
        if prefix not in description:
            description = f"{description} {prefix}"

    return " ".join(description.split()), normalized_size


def _normalize_support_ocr_token(value: str) -> str:
    value = SUPPORT_OCR_PREFIX_RE.sub("5", value, count=1)
    return re.sub(r"^5MHR(\d*)-5(?=-)", r"5MHR\1-S", value, count=1)


def _normalize_material_description_ocr(description: str) -> str:
    description = re.sub(r"\bSCH 105\b", "SCH 10S", description)
    description = re.sub(r"\bPIPET 105(?=\s+X\b)", "PIPET 10S", description)
    description = re.sub(r"\b31655\b", "316SS", description)
    description = re.sub(
        r"\b316/316L\s+55(?:\s+sec,)?(?=\s|$)",
        "316/316L SS",
        description,
        flags=re.IGNORECASE,
    )
    description = re.sub(r"\bSS 105 BORE\b", "SS 10S BORE", description)
    return " ".join(description.split())


def _normalize_support_ocr(description: str, code: str) -> Tuple[str, str]:
    normalized_description = _normalize_support_ocr_token(description)
    normalized_code = _normalize_support_ocr_token(code)
    if normalized_description.startswith("5"):
        return normalized_description, normalized_code

    match = SUPPORT_CODE_PREFIX_RE.match(normalized_code)
    if not match:
        return normalized_description, normalized_code
    upper_description = normalized_description.upper()
    if not any(marker in upper_description for marker in SUPPORT_DESCRIPTION_MARKERS):
        return normalized_description, normalized_code
    return f"{match.group(1)}, {normalized_description}", normalized_code


def _material_row_lines(
    lines: Sequence[Sequence[Word]],
    point_word: Word,
    bounds: Sequence[float],
    *,
    max_line_gap: float = 32.0,
    max_row_depth: float = 85.0,
) -> List[Sequence[Word]]:
    material_lines: List[Sequence[Word]] = []
    for line in lines:
        if not line:
            continue
        line_y = min(w.y0 for w in line)
        if line_y - point_word.y0 >= max_row_depth:
            break
        if material_lines:
            previous_y = min(w.y0 for w in material_lines[-1])
            if line_y - previous_y > max_line_gap:
                break
        if _is_floating_note_line(line):
            continue
        if _is_title_block_metadata_line(line):
            break
        cleaned = _clean_material_line(line, bounds)
        if cleaned:
            material_lines.append(cleaned)
    return material_lines


def _commodity_code(words: Sequence[Word], anchor: float) -> Tuple[str, List[str]]:
    """Select a commodity code without absorbing nearby revision-cloud digits."""
    tokens = [w for w in words if COMMODITY_RE.match(w.text)]
    if not tokens:
        return "", []
    substantive = [
        w for w in tokens
        if not (NUMBER_RE.match(w.text) and len(w.text) <= 2 and abs(w.cx - anchor) > 45)
    ]
    notes = ["ignored_numeric_annotation"] if len(substantive) != len(tokens) else []
    if len(substantive) == 1:
        return substantive[0].text, notes
    if not substantive and len(tokens) == 1:
        return tokens[0].text, []
    if substantive:
        lines = _line_groups(substantive, tolerance=5.0)
        if len(lines) == 1:
            return _join(lines[0]), notes
        ordered = sorted(lines, key=lambda line: min(abs(w.cx - anchor) for w in line))
        closest = ordered[0]
        if len(ordered) == 1:
            return _join(closest), notes
        closest_distance = min(abs(w.cx - anchor) for w in closest)
        next_distance = min(abs(w.cx - anchor) for w in ordered[1])
        if next_distance - closest_distance >= 35:
            return _join(closest), sorted(set(notes + ["ignored_numeric_annotation"]))
    if len(substantive) > 1:
        return _join(substantive), ["multiple_commodity_code_candidates"]
    return _join(tokens), ["multiple_commodity_code_candidates"]


def _quantity(words: Sequence[Word], anchor: float) -> Tuple[str, List[str]]:
    candidates = [w for w in words if QUANTITY_RE.match(w.text)]
    if not candidates:
        return "", []
    ordered = sorted(candidates, key=lambda w: (abs(w.cx - anchor), w.y0, w.x0))
    chosen = ordered[0]
    if len(ordered) == 1:
        return chosen.text, []
    distance_gap = abs(ordered[1].cx - anchor) - abs(chosen.cx - anchor)
    if abs(chosen.cx - anchor) <= 20 and distance_gap >= 8:
        return chosen.text, ["ignored_numeric_annotation"]
    return chosen.text, ["multiple_quantity_candidates"]


def parse_page(page: fitz.Page, page_number: int) -> PageResult:
    words = _display_words(page)
    native_chars = len(page.get_text("text").strip())
    base = {"page": page_number, "native_text_chars": native_chars, "ocr_derived": False}
    if native_chars < 40:
        return PageResult([], {**base, "status": "ocr_required", "reason": "image_or_sparse_text_page"})

    header = _find_header(words)
    if not header:
        return PageResult([], {**base, "status": "review", "reason": "bom_header_not_detected"})

    xs = [header[k] for k in ("PT", "DESCRIPTION", "NPD", "CMDTY", "QTY")]
    if xs != sorted(xs):
        return PageResult([], {**base, "status": "review", "reason": "column_order_ambiguous", "header": header})
    # Header labels are centered while data are left/right aligned. Empirically
    # derive starts from header anchors instead of splitting header centers.
    bounds = [xs[0] + 20.0, xs[2] - 25.0, xs[3] - 15.0, xs[4] - 25.0]
    pt_left = max(0.0, xs[0] - 25.0)
    qty_right = min(page.rect.width, xs[4] + max(24.0, (xs[4] - xs[3]) * 0.22))
    table_words = [w for w in words if w.y0 > header["HEADER_Y"] + 1 and pt_left <= w.cx <= qty_right]
    lines = _line_groups(table_words)

    starts: List[Tuple[int, Word, bool]] = []
    for index, line in enumerate(lines):
        pts = [w for w in line if w.cx < bounds[0] and POINT_RE.match(w.text)]
        if pts:
            point_word = min(pts, key=lambda w: abs(w.cx - header["PT"]))
            if (
                abs(point_word.cx - header["PT"]) <= 20
                and not _is_revision_history_line(line)
                and _has_material_start_evidence(line, point_word, bounds)
            ):
                starts.append((index, point_word, len(pts) > 1))
    rows: List[BomRow] = []
    for pos, (start_index, point_word, point_annotations) in enumerate(starts):
        end_index = starts[pos + 1][0] if pos + 1 < len(starts) else len(lines)
        row_lines = lines[start_index:end_index]
        # Final BOM rows can sit close to field-weld notes and the title block.
        # Keep contiguous material text and ignore known floating drawing notes
        # before they become false size/commodity candidates.
        material_lines = _material_row_lines(row_lines, point_word, bounds)
        row_words = [w for line in material_lines for w in line]
        cells = [[], [], [], [], []]
        for w in row_words:
            if w is point_word:
                continue
            if w.cx < bounds[0]:
                if w.cx < bounds[0] - 12.0:
                    continue
                idx = 0 if POINT_RE.match(w.text) else 1
            else:
                idx = 1 if w.cx < bounds[1] else 2 if w.cx < bounds[2] else 3 if w.cx < bounds[3] else 4
            cells[idx].append(w)
        if not any(cells):
            continue
        description_words: List[Word] = []
        ignored_description_annotation = False
        for line in _line_groups(cells[1]):
            if len(line) == 1 and POINT_RE.match(line[0].text):
                ignored_description_annotation = True
                continue
            description_words.extend(line)
        description = _join(description_words)
        size = _join(cells[2])
        description, size = _move_size_prefix_to_description(description, size)
        description = _normalize_material_description_ocr(description)
        code, code_notes = _commodity_code(cells[3], header["CMDTY"])
        description, code = _normalize_support_ocr(description, code)
        qty_tokens = sorted(cells[4], key=lambda w: (w.y0, w.x0))
        quantity, quantity_notes = _quantity(qty_tokens, header["QTY"])
        notes: List[str] = code_notes + quantity_notes
        if point_annotations or ignored_description_annotation:
            notes.append("ignored_numeric_annotation")
        if not description:
            notes.append("missing_description")
        all_words = [point_word] + row_words
        bbox = (min(w.x0 for w in all_words), min(w.y0 for w in all_words), max(w.x1 for w in all_words), max(w.y1 for w in all_words))
        raw_text = " | ".join(_join(line) for line in material_lines if _join(line))
        rows.append(BomRow(
            point_word.text, description, size, code, quantity, raw_text, bbox,
            sorted(set(notes)),
        ))
    status = "ok" if rows else "review"
    reason = "" if rows else "bom_detected_but_no_rows"
    return PageResult(rows, {**base, "status": status, "reason": reason, "header": {k: round(v, 2) for k, v in header.items()}, "row_count": len(rows)})


def parse_pdf(path: Path) -> Tuple[List[BomRow], Dict[str, object]]:
    try:
        doc = fitz.open(path)
    except Exception as exc:
        return [], {"status": "error", "error": type(exc).__name__, "message": str(exc), "pages": []}
    rows: List[BomRow] = []
    pages = []
    try:
        for number, page in enumerate(doc, 1):
            result = parse_page(page, number)
            for row in result.rows:
                setattr(row, "_page", number)
            rows.extend(result.rows)
            pages.append(result.audit)
    except Exception as exc:
        return rows, {"status": "error", "error": type(exc).__name__, "message": str(exc), "pages": pages}
    finally:
        doc.close()
    return rows, {"status": "processed", "page_count": len(pages), "pages": pages}
