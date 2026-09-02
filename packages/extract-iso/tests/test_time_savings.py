from decimal import Decimal
from time import perf_counter

from iso_bom.time_savings import (
    TIME_MODEL_VERSION,
    fmr_time_estimate,
    is_overflow_description,
    pipe_time_estimate,
    processing_seconds,
)


def test_fmr_time_estimate_uses_exact_decimal_components():
    estimate = fmr_time_estimate(2, 2, 1)
    assert estimate["time_model_version"] == TIME_MODEL_VERSION
    assert estimate["time_estimate_available"] is True
    assert estimate["estimated_time_saved_seconds"] == "130.02"
    assert estimate["time_saved_breakdown"] == {
        "selected_iso_count": 2,
        "material_rows": 2,
        "normal_material_rows": 1,
        "overflow_material_rows": 1,
        "package_setup_seconds": "17.30",
        "iso_setup_seconds": "66.72",
        "normal_material_entry_seconds": "20.00",
        "overflow_material_entry_seconds": "26.00",
    }


def test_overflow_boundary_and_pipe_zero_footage_iso_timing():
    assert not is_overflow_description("X" * 52)
    assert is_overflow_description("X" * 53)
    estimate = pipe_time_estimate(2)
    assert estimate["estimated_time_saved_seconds"] == "50.66"
    assert estimate["time_saved_breakdown"]["selected_iso_count"] == 2


def test_unavailable_estimates_and_processing_duration():
    assert fmr_time_estimate(1, 1, 0, eligible=False)["estimated_time_saved_seconds"] is None
    assert pipe_time_estimate(0)["time_estimate_available"] is False
    elapsed = Decimal(processing_seconds(perf_counter() - 0.01))
    assert elapsed > 0
