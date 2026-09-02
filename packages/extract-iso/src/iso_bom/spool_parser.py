import re
from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

import fitz

from .spool_model import SpoolCandidate, SpoolMarker


COLOR_TOLERANCE = 0.2
GEOMETRY_TOLERANCE = 1.5
BOX_DEDUPLICATION_TOLERANCE = 1.5
BLUE_MINIMUM = 0.4
BLUE_CHANNEL_MAXIMUM = 0.35
BLUE_DOMINANCE = 0.2
MIN_NUMERIC_SPOOL_DIGITS = 3
BOLT_UP_RE = re.compile(r"^BU-", re.IGNORECASE)


@dataclass(frozen=True)
class _TextSpan:
    order: int
    line_key: Tuple[int, int]
    text: str
    bbox: Tuple[float, float, float, float]
    color: int
    direction: Tuple[float, float]

    @property
    def center(self) -> fitz.Point:
        rect = fitz.Rect(self.bbox)
        return fitz.Point((rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2)


def _near_red(color: Sequence[float]) -> bool:
    return (
        len(color) >= 3
        and float(color[0]) >= 1.0 - COLOR_TOLERANCE
        and abs(float(color[1])) <= COLOR_TOLERANCE
        and abs(float(color[2])) <= COLOR_TOLERANCE
    )


def _near_blue(color: Sequence[float]) -> bool:
    return (
        len(color) >= 3
        and float(color[2]) >= BLUE_MINIMUM
        and float(color[0]) <= BLUE_CHANNEL_MAXIMUM
        and float(color[1]) <= BLUE_CHANNEL_MAXIMUM
        and float(color[2]) - float(color[0]) >= BLUE_DOMINANCE
        and float(color[2]) - float(color[1]) >= BLUE_DOMINANCE
    )


def _span_is_red(span: _TextSpan) -> bool:
    red, green, blue = fitz.sRGB_to_rgb(span.color)
    return red >= 205 and green <= 51 and blue <= 51


def _plausible_spool_value(value: str) -> bool:
    return not value.isdigit() or len(value) >= MIN_NUMERIC_SPOOL_DIGITS


def _text_spans(page: fitz.Page) -> List[_TextSpan]:
    spans: List[_TextSpan] = []
    order = 0
    for block_index, block in enumerate(page.get_text("dict").get("blocks", [])):
        for line_index, line in enumerate(block.get("lines", [])):
            raw_direction = line.get("dir") or (1.0, 0.0)
            direction = (float(raw_direction[0]), float(raw_direction[1]))
            for span in line.get("spans", []):
                text = str(span.get("text") or "")
                if not text.strip():
                    continue
                spans.append(_TextSpan(
                    order=order,
                    line_key=(block_index, line_index),
                    text=text,
                    bbox=tuple(float(value) for value in span["bbox"]),
                    color=int(span.get("color") or 0),
                    direction=direction,
                ))
                order += 1
    return spans


def _same_rect(first: fitz.Rect, second: fitz.Rect) -> bool:
    return all(
        abs(left - right) <= BOX_DEDUPLICATION_TOLERANCE
        for left, right in zip(first, second)
    )


def _append_unique_box(boxes: List[fitz.Rect], candidate: fitz.Rect) -> None:
    candidate = fitz.Rect(candidate)
    if candidate.width <= GEOMETRY_TOLERANCE or candidate.height <= GEOMETRY_TOLERANCE:
        return
    if not any(_same_rect(box, candidate) for box in boxes):
        boxes.append(candidate)


def _line_segments(items: Iterable[Tuple[object, ...]]) -> List[Tuple[fitz.Point, fitz.Point]]:
    result: List[Tuple[fitz.Point, fitz.Point]] = []
    for item in items:
        if item and item[0] == "l" and len(item) >= 3:
            result.append((fitz.Point(item[1]), fitz.Point(item[2])))
    return result


def _normalized_segment(
    segment: Tuple[fitz.Point, fitz.Point],
) -> Tuple[str, float, float, float]:
    first, second = segment
    if abs(first.x - second.x) <= GEOMETRY_TOLERANCE:
        return "v", (first.x + second.x) / 2, min(first.y, second.y), max(first.y, second.y)
    if abs(first.y - second.y) <= GEOMETRY_TOLERANCE:
        return "h", (first.y + second.y) / 2, min(first.x, second.x), max(first.x, second.x)
    return "", 0.0, 0.0, 0.0


def _has_edge(
    segments: Sequence[Tuple[str, float, float, float]],
    orientation: str,
    coordinate: float,
    start: float,
    end: float,
) -> bool:
    return any(
        kind == orientation
        and abs(position - coordinate) <= GEOMETRY_TOLERANCE
        and abs(edge_start - start) <= GEOMETRY_TOLERANCE
        and abs(edge_end - end) <= GEOMETRY_TOLERANCE
        for kind, position, edge_start, edge_end in segments
    )


def _rect_from_path_segments(
    segments: Sequence[Tuple[fitz.Point, fitz.Point]],
) -> fitz.Rect:
    normalized = [value for value in map(_normalized_segment, segments) if value[0]]
    if len(normalized) < 4:
        return fitz.Rect()
    xs = sorted({round(position, 3) for kind, position, _, _ in normalized if kind == "v"})
    ys = sorted({round(position, 3) for kind, position, _, _ in normalized if kind == "h"})
    for left_index, left in enumerate(xs):
        for right in xs[left_index + 1:]:
            for top_index, top in enumerate(ys):
                for bottom in ys[top_index + 1:]:
                    if (
                        _has_edge(normalized, "v", left, top, bottom)
                        and _has_edge(normalized, "v", right, top, bottom)
                        and _has_edge(normalized, "h", top, left, right)
                        and _has_edge(normalized, "h", bottom, left, right)
                    ):
                        return fitz.Rect(left, top, right, bottom)
    return fitz.Rect()


def _red_box_rectangles(page: fitz.Page) -> List[fitz.Rect]:
    boxes: List[fitz.Rect] = []
    all_segments: List[Tuple[fitz.Point, fitz.Point]] = []

    for drawing in page.get_drawings():
        stroke = drawing.get("color") or ()
        if not _near_red(stroke):
            continue
        items = drawing.get("items", [])
        for item in items:
            if item and item[0] == "re" and len(item) >= 2:
                _append_unique_box(boxes, fitz.Rect(item[1]))
        segments = _line_segments(items)
        all_segments.extend(segments)
        if len(segments) <= 12:
            path_rect = _rect_from_path_segments(segments)
            if not path_rect.is_empty:
                _append_unique_box(boxes, path_rect)

    normalized = [value for value in map(_normalized_segment, all_segments) if value[0]]
    quantize = lambda value: int(round(value / GEOMETRY_TOLERANCE))
    horizontal_keys = {
        (quantize(position), quantize(start), quantize(end))
        for kind, position, start, end in normalized
        if kind == "h"
    }
    vertical_groups: Dict[Tuple[int, int], List[Tuple[float, float, float]]] = {}
    for kind, position, start, end in normalized:
        if kind == "v":
            vertical_groups.setdefault(
                (quantize(start), quantize(end)), []
            ).append((position, start, end))

    def has_horizontal(position: float, start: float, end: float) -> bool:
        target = (quantize(position), quantize(start), quantize(end))
        return any(
            (target[0] + dy, target[1] + dx0, target[2] + dx1) in horizontal_keys
            for dy in (-1, 0, 1)
            for dx0 in (-1, 0, 1)
            for dx1 in (-1, 0, 1)
        )

    for vertical_edges in vertical_groups.values():
        for index, (first_x, top, bottom) in enumerate(vertical_edges):
            for second_x, _, _ in vertical_edges[index + 1:]:
                left, right = sorted((first_x, second_x))
                if right - left <= GEOMETRY_TOLERANCE:
                    continue
                if has_horizontal(top, left, right) and has_horizontal(bottom, left, right):
                    _append_unique_box(boxes, fitz.Rect(left, top, right, bottom))

    boxes.sort(key=lambda box: (box.y0, box.x0, box.y1, box.x1))
    return boxes


_Curve = Tuple[fitz.Point, fitz.Point, fitz.Point, fitz.Point]


def _curve_from_item(item: Tuple[object, ...]) -> _Curve:
    return (
        fitz.Point(item[1]),
        fitz.Point(item[2]),
        fitz.Point(item[3]),
        fitz.Point(item[4]),
    )


def _reverse_curve(curve: _Curve) -> _Curve:
    return curve[3], curve[2], curve[1], curve[0]


def _points_near(first: fitz.Point, second: fitz.Point) -> bool:
    return (
        abs(first.x - second.x) <= GEOMETRY_TOLERANCE
        and abs(first.y - second.y) <= GEOMETRY_TOLERANCE
    )


def _ordered_closed_curve_chain(curves: Sequence[_Curve]) -> List[_Curve]:
    if len(curves) != 4:
        return []

    def extend(chain: List[_Curve], remaining: List[int]) -> List[_Curve]:
        if not remaining:
            return chain if _points_near(chain[-1][3], chain[0][0]) else []
        endpoint = chain[-1][3]
        for position, curve_index in enumerate(remaining):
            curve = curves[curve_index]
            for oriented in (curve, _reverse_curve(curve)):
                if not _points_near(endpoint, oriented[0]):
                    continue
                result = extend(
                    chain + [oriented],
                    remaining[:position] + remaining[position + 1:],
                )
                if result:
                    return result
        return []

    for first_index, first in enumerate(curves):
        remaining = [index for index in range(4) if index != first_index]
        for oriented in (first, _reverse_curve(first)):
            result = extend([oriented], remaining)
            if result:
                return result
    return []


def _curve_bounds(curves: Sequence[_Curve]) -> fitz.Rect:
    points = [point for curve in curves for point in curve]
    if not points:
        return fitz.Rect()
    rect = fitz.Rect(points[0], points[0])
    for point in points[1:]:
        rect.include_point(point)
    return rect


def _ellipse_rect_from_curves(
    curves: Sequence[_Curve],
    bounds: Optional[fitz.Rect] = None,
) -> fitz.Rect:
    ordered = _ordered_closed_curve_chain(curves)
    if not ordered:
        return fitz.Rect()
    rect = (
        fitz.Rect(bounds)
        if bounds is not None and not bounds.is_empty
        else _curve_bounds(ordered)
    )
    if rect.width <= GEOMETRY_TOLERANCE or rect.height <= GEOMETRY_TOLERANCE:
        return fitz.Rect()

    center = fitz.Point((rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2)
    cardinal_points = [
        fitz.Point(center.x, rect.y0),
        fitz.Point(rect.x1, center.y),
        fitz.Point(center.x, rect.y1),
        fitz.Point(rect.x0, center.y),
    ]
    endpoints = [ordered[0][0]] + [curve[3] for curve in ordered[:-1]]
    endpoint_tolerance = max(
        GEOMETRY_TOLERANCE * 2,
        min(rect.width, rect.height) * 0.08,
    )
    unmatched = list(cardinal_points)
    for endpoint in endpoints:
        match = next((
            index for index, cardinal in enumerate(unmatched)
            if abs(endpoint.x - cardinal.x) <= endpoint_tolerance
            and abs(endpoint.y - cardinal.y) <= endpoint_tolerance
        ), None)
        if match is None:
            return fitz.Rect()
        unmatched.pop(match)
    return rect


def _blue_oval_rectangles(page: fitz.Page) -> List[fitz.Rect]:
    """Return structurally complete blue ovals, excluding blue leaders/lines."""
    ovals: List[fitz.Rect] = []
    partial_curves: List[_Curve] = []

    for drawing in page.get_drawings():
        if not _near_blue(drawing.get("color") or ()):
            continue
        items = drawing.get("items", [])
        if not items or any(
            not item or item[0] != "c" or len(item) < 5
            for item in items
        ):
            continue
        curves = [_curve_from_item(item) for item in items]
        if len(curves) == 4:
            oval = _ellipse_rect_from_curves(curves, fitz.Rect(drawing["rect"]))
            if not oval.is_empty:
                _append_unique_box(ovals, oval)
        elif len(curves) < 4:
            partial_curves.extend(curves)

    if partial_curves:
        parents = list(range(len(partial_curves)))

        def find(index: int) -> int:
            while parents[index] != index:
                parents[index] = parents[parents[index]]
                index = parents[index]
            return index

        def union(first: int, second: int) -> None:
            first_root, second_root = find(first), find(second)
            if first_root != second_root:
                parents[second_root] = first_root

        endpoint_buckets: Dict[Tuple[int, int], List[Tuple[int, fitz.Point]]] = {}
        scale = GEOMETRY_TOLERANCE
        for index, curve in enumerate(partial_curves):
            for endpoint in (curve[0], curve[3]):
                key = (int(round(endpoint.x / scale)), int(round(endpoint.y / scale)))
                for x_offset in (-1, 0, 1):
                    for y_offset in (-1, 0, 1):
                        for other_index, other_endpoint in endpoint_buckets.get(
                            (key[0] + x_offset, key[1] + y_offset), []
                        ):
                            if _points_near(endpoint, other_endpoint):
                                union(index, other_index)
                endpoint_buckets.setdefault(key, []).append((index, endpoint))

        components: Dict[int, List[_Curve]] = {}
        for index, curve in enumerate(partial_curves):
            components.setdefault(find(index), []).append(curve)
        for component in components.values():
            if len(component) != 4:
                continue
            oval = _ellipse_rect_from_curves(component)
            if not oval.is_empty:
                _append_unique_box(ovals, oval)

    ovals.sort(key=lambda oval: (oval.y0, oval.x0, oval.y1, oval.x1))
    return ovals


def _line_values(spans: Sequence[_TextSpan]) -> List[Tuple[str, List[_TextSpan]]]:
    grouped: Dict[Tuple[int, int], List[_TextSpan]] = {}
    for span in spans:
        grouped.setdefault(span.line_key, []).append(span)
    result: List[Tuple[str, List[_TextSpan]]] = []
    for line_spans in grouped.values():
        line_spans.sort(key=lambda span: span.order)
        value = re.sub(r"\s+", "", "".join(span.text for span in line_spans))
        if value:
            result.append((value, line_spans))
    result.sort(key=lambda item: min(span.order for span in item[1]))
    return result


def _collinear_span_value(
    spans: Sequence[_TextSpan],
    container: fitz.Rect,
) -> Tuple[str, List[_TextSpan]]:
    """Combine split text runs that lie on one visual line in an oval."""
    if not spans:
        return "", []
    direction_x, direction_y = spans[0].direction
    magnitude = (direction_x ** 2 + direction_y ** 2) ** 0.5
    if magnitude <= 0.01:
        return "", []
    direction_x, direction_y = direction_x / magnitude, direction_y / magnitude
    for span in spans[1:]:
        other_x, other_y = span.direction
        other_magnitude = (other_x ** 2 + other_y ** 2) ** 0.5
        if other_magnitude <= 0.01:
            return "", []
        alignment = (
            direction_x * other_x / other_magnitude
            + direction_y * other_y / other_magnitude
        )
        if alignment < 0.9:
            return "", []

    perpendicular = (-direction_y, direction_x)
    centers = [span.center for span in spans]
    perpendicular_positions = [
        center.x * perpendicular[0] + center.y * perpendicular[1]
        for center in centers
    ]
    corners = [
        container.top_left,
        container.top_right,
        container.bottom_left,
        container.bottom_right,
    ]
    container_positions = [
        point.x * perpendicular[0] + point.y * perpendicular[1]
        for point in corners
    ]
    allowed_spread = max(
        GEOMETRY_TOLERANCE * 2,
        (max(container_positions) - min(container_positions)) * 0.25,
    )
    if max(perpendicular_positions) - min(perpendicular_positions) > allowed_spread:
        return "", []

    ordered = sorted(
        spans,
        key=lambda span: (
            span.center.x * direction_x + span.center.y * direction_y,
            span.order,
        ),
    )
    value = re.sub(r"\s+", "", "".join(span.text for span in ordered))
    return value, ordered


def _append_unique_marker(
    markers: List[SpoolMarker],
    value: str,
    container: fitz.Rect,
) -> None:
    if any(
        marker.value == value
        and _same_rect(fitz.Rect(marker.bbox), container)
        for marker in markers
    ):
        return
    markers.append(SpoolMarker(
        value=value,
        bbox=tuple(float(number) for number in container),
    ))


def extract_spool_markers(
    page: fitz.Page,
) -> Tuple[List[SpoolMarker], List[SpoolCandidate]]:
    spans = _text_spans(page)
    markers: List[SpoolMarker] = []
    candidates: List[SpoolCandidate] = []
    consumed_orders = set()

    for box in _red_box_rectangles(page):
        contained = [span for span in spans if box.contains(span.center)]
        lines = _line_values(contained)
        if any(BOLT_UP_RE.match(value) for value, _spans in lines):
            consumed_orders.update(
                span.order for _value, line_spans in lines for span in line_spans
            )
            continue
        if (
            len(lines) == 1
            and re.fullmatch(r"\d+", lines[0][0])
            and _plausible_spool_value(lines[0][0])
        ):
            value, value_spans = lines[0]
            _append_unique_marker(markers, value, box)
            consumed_orders.update(span.order for span in value_spans)
            continue

        for value, value_spans in (
            item for item in lines
            if re.fullmatch(r"\d+", item[0])
            and _plausible_spool_value(item[0])
        ):
            candidates.append(SpoolCandidate(
                value=value,
                bbox=tuple(float(number) for number in box),
                reason="multiple_digit_lines_in_red_box",
            ))
            consumed_orders.update(span.order for span in value_spans)

    for oval in _blue_oval_rectangles(page):
        contained = [span for span in spans if oval.contains(span.center)]
        lines = _line_values(contained)
        if len(lines) == 1:
            value, value_spans = lines[0]
            if _plausible_spool_value(value):
                _append_unique_marker(markers, value, oval)
            consumed_orders.update(span.order for span in value_spans)
            continue

        combined_value, combined_spans = _collinear_span_value(contained, oval)
        if combined_value and _plausible_spool_value(combined_value):
            _append_unique_marker(markers, combined_value, oval)
            consumed_orders.update(span.order for span in combined_spans)
            continue

        for value, value_spans in lines:
            if not _plausible_spool_value(value):
                continue
            candidates.append(SpoolCandidate(
                value=value,
                bbox=tuple(float(number) for number in oval),
                reason="multiple_text_lines_in_blue_circle",
            ))
            consumed_orders.update(span.order for span in value_spans)

    for value, value_spans in _line_values(spans):
        if (
            re.fullmatch(r"\d+", value)
            and _plausible_spool_value(value)
            and any(_span_is_red(span) for span in value_spans)
            and not all(span.order in consumed_orders for span in value_spans)
        ):
            rect = fitz.Rect(value_spans[0].bbox)
            for span in value_spans[1:]:
                rect.include_rect(fitz.Rect(span.bbox))
            candidates.append(SpoolCandidate(
                value=value,
                bbox=tuple(float(number) for number in rect),
                reason="unboxed_red_digit_candidate",
            ))

    markers.sort(key=lambda marker: (marker.bbox[1], marker.bbox[0], marker.value))
    unique_candidates: List[SpoolCandidate] = []
    for candidate in sorted(
        candidates, key=lambda item: (item.bbox[1], item.bbox[0], item.value)
    ):
        if any(
            existing.value == candidate.value
            and existing.reason == candidate.reason
            and _same_rect(fitz.Rect(existing.bbox), fitz.Rect(candidate.bbox))
            for existing in unique_candidates
        ):
            continue
        unique_candidates.append(candidate)
    return markers, unique_candidates
