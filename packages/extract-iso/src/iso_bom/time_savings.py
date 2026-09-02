from decimal import Decimal, InvalidOperation
from time import perf_counter
from typing import Dict, Iterable, Mapping


TIME_MODEL_VERSION = "manual-active-v1"
OVERFLOW_DESCRIPTION_LENGTH = 52

FMR_PACKAGE_SECONDS = Decimal("17.30")
FMR_ISO_SECONDS = Decimal("33.36")
FMR_NORMAL_ROW_SECONDS = Decimal("20.00")
FMR_OVERFLOW_ROW_SECONDS = Decimal("26.00")

PIPE_PACKAGE_SECONDS = Decimal("34.66")
PIPE_ISO_SECONDS = Decimal("8.00")


def decimal_text(value: Decimal) -> str:
    return format(value, "f")


def decimal_value(value, default: Decimal = Decimal("0")) -> Decimal:
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return default


def is_overflow_description(description: object) -> bool:
    return len(str(description or "")) > OVERFLOW_DESCRIPTION_LENGTH


def processing_seconds(started_at: float) -> str:
    elapsed = Decimal(str(max(0.0, perf_counter() - started_at)))
    return decimal_text(elapsed.quantize(Decimal("0.000001")))


def unavailable_estimate(reason: str, **counts: int) -> Dict[str, object]:
    return {
        "time_model_version": TIME_MODEL_VERSION,
        "time_estimate_available": False,
        "time_estimate_reason": reason,
        "estimated_time_saved_seconds": None,
        "time_saved_breakdown": {key: int(value) for key, value in counts.items()},
    }


def fmr_time_estimate(
    selected_iso_count: int,
    material_rows: int,
    overflow_material_rows: int,
    *,
    eligible: bool = True,
) -> Dict[str, object]:
    selected_iso_count = max(0, int(selected_iso_count))
    material_rows = max(0, int(material_rows))
    overflow_material_rows = max(0, min(int(overflow_material_rows), material_rows))
    normal_material_rows = material_rows - overflow_material_rows
    counts = {
        "selected_iso_count": selected_iso_count,
        "material_rows": material_rows,
        "normal_material_rows": normal_material_rows,
        "overflow_material_rows": overflow_material_rows,
    }
    if not eligible or selected_iso_count == 0:
        return unavailable_estimate("no_completed_fmr_workbook", **counts)

    package_component = FMR_PACKAGE_SECONDS
    iso_component = FMR_ISO_SECONDS * selected_iso_count
    normal_component = FMR_NORMAL_ROW_SECONDS * normal_material_rows
    overflow_component = FMR_OVERFLOW_ROW_SECONDS * overflow_material_rows
    total = package_component + iso_component + normal_component + overflow_component
    return {
        "time_model_version": TIME_MODEL_VERSION,
        "time_estimate_available": True,
        "time_estimate_reason": "",
        "estimated_time_saved_seconds": decimal_text(total),
        "time_saved_breakdown": {
            **counts,
            "package_setup_seconds": decimal_text(package_component),
            "iso_setup_seconds": decimal_text(iso_component),
            "normal_material_entry_seconds": decimal_text(normal_component),
            "overflow_material_entry_seconds": decimal_text(overflow_component),
        },
    }


def pipe_time_estimate(
    selected_iso_count: int,
    *,
    eligible: bool = True,
) -> Dict[str, object]:
    selected_iso_count = max(0, int(selected_iso_count))
    counts = {"selected_iso_count": selected_iso_count}
    if not eligible or selected_iso_count == 0:
        return unavailable_estimate("no_trustworthy_pipe_report", **counts)

    package_component = PIPE_PACKAGE_SECONDS
    iso_component = PIPE_ISO_SECONDS * selected_iso_count
    total = package_component + iso_component
    return {
        "time_model_version": TIME_MODEL_VERSION,
        "time_estimate_available": True,
        "time_estimate_reason": "",
        "estimated_time_saved_seconds": decimal_text(total),
        "time_saved_breakdown": {
            **counts,
            "package_setup_seconds": decimal_text(package_component),
            "iso_entry_seconds": decimal_text(iso_component),
        },
    }


def fmr_iso_time_saved(material_rows: int, overflow_material_rows: int) -> str:
    material_rows = max(0, int(material_rows))
    overflow_material_rows = max(0, min(int(overflow_material_rows), material_rows))
    normal_rows = material_rows - overflow_material_rows
    total = (
        FMR_ISO_SECONDS
        + FMR_NORMAL_ROW_SECONDS * normal_rows
        + FMR_OVERFLOW_ROW_SECONDS * overflow_material_rows
    )
    return decimal_text(total)


def pipe_iso_time_saved() -> str:
    return decimal_text(PIPE_ISO_SECONDS)


def aggregate_iso_counts(isos: Iterable[Mapping[str, object]]) -> Dict[str, int]:
    selected = material_rows = overflow_rows = 0
    for iso in isos:
        selected += 1
        material_rows += int(iso.get("material_rows") or 0)
        overflow_rows += int(iso.get("overflow_material_rows") or 0)
    return {
        "selected_iso_count": selected,
        "material_rows": material_rows,
        "overflow_material_rows": overflow_rows,
    }
