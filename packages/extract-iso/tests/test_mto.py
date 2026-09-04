"""Material Takeoff classification.

An MTO is what the material team buys from, so a row in the wrong category is
not a cosmetic problem: bolts and gaskets are quoted by different suppliers on
different lead times than pipe, and pipe is bought by the foot while
everything else is counted.

Every case here comes from a real drawing in the project's own packages.
"""

from iso_bom.mto import (
    item_type, line_number, sheet_number, takeoff, takeoff_row, takeoff_sheet,
    SHEET_BOLTS_GASKETS, SHEET_COMBINED, SHEET_PIPE_FITTINGS,
)


def test_a_support_is_counted_not_measured():
    # This is the one that cost 344 rows. The description names the pipe the
    # support holds; reading it as pipe puts hardware on a by-the-foot order.
    assert item_type('5UGSP, U-BOLT GUIDE FOR INSULATED LINES 2" PIPE', "5UGSP-02-15") == "SUPPORT"
    assert item_type('5CH, SUPPORT CRADLE HOT SERVICE 2" PIPE', "5CH-02-15") == "SUPPORT"
    assert item_type('5CI, ISOLATION CRADLE, 2" PIPE, SS', "5CI-04") == "SUPPORT"


def test_actual_pipe_is_pipe():
    assert item_type("PIPE SCH 40 ERW STL A53-B", "5356648") == "PIPE"
    assert item_type("PIPE SCH 10S ERW 316/316L SS A312", "5368751") == "PIPE"


def test_bolts_and_gaskets_are_their_own_category():
    # They are bought separately, which is why the form has a sheet for them.
    assert item_type("STUD-BOLT A193 GR B8M W/A194 GR 8M NUTS", "5676576L") == "BOLT"
    assert item_type("GASKET 150# PTFE RING 1/8in THK", "5669399L") == "GASKET"
    assert takeoff_sheet("BOLT") == SHEET_BOLTS_GASKETS
    assert takeoff_sheet("GASKET") == SHEET_BOLTS_GASKETS


def test_fittings_go_with_pipe():
    assert item_type("ELL 90 LR SCH 10S 316L SS A403-W", "5450786") == "FITTING"
    assert item_type("FLG LAP JOINT 150# 316 SS", "5599578L") == "FITTING"
    assert takeoff_sheet("FITTING") == SHEET_PIPE_FITTINGS
    assert takeoff_sheet("PIPE") == SHEET_PIPE_FITTINGS


def test_anything_unrecognised_still_reaches_the_buyer():
    # A row nobody classified is worse than a row in the wrong column: it
    # would be bought by nobody. COMBINED is the catch-all for that reason.
    assert item_type("BIRDSCREEN 316 SS 45 DEG", "LP131 BS-9411V1") == "SPECIALTY"
    assert takeoff_sheet("SPECIALTY") == SHEET_COMBINED


def test_pipe_is_ordered_by_the_foot_with_the_mark_stripped():
    row = takeoff_row(
        {"description": "PIPE SCH 40 ERW STL A53-B", "commodityCode": "5356648",
         "nominalSize": "2", "quantity": "19.1'"},
        {"drawingNumber": "LP131-HHWR-1091320-04", "pipeSchedule": "6"},
        {"iwpNumber": "IP-SMM30R107MMPP-K447", "cwa": "30R"},
    )
    assert row["uom"] == "LF"
    assert row["quantity"] == "19.1", "a foot mark in a quantity cell is not a number"
    assert row["pipeSpec"] == "6", "the buyer orders wall thickness against this"


def test_counted_material_keeps_its_own_quantity():
    row = takeoff_row(
        {"description": "GASKET 150# PTFE RING", "commodityCode": "5669399L",
         "nominalSize": "6", "quantity": "2"},
        {"drawingNumber": "LP131-EMR-286013-04", "pipeSchedule": "315"},
        {"iwpNumber": "IWP-1", "cwa": "10D"},
    )
    assert row["uom"] == "EA"
    assert row["quantity"] == "2"


def test_the_sheet_is_split_off_the_line_number():
    # The form keeps them in separate columns, and the drawing writes them
    # joined. LP131-PV-941006-03 is sheet 03 of line LP131-PV-941006.
    assert line_number("LP131-PV-941006-03") == "LP131-PV-941006"
    assert sheet_number("LP131-PV-941006-03") == "03"
    assert sheet_number("LP131-N2(100)-763111-08") == "08"
    assert sheet_number("") == ""


def test_a_package_becomes_rows_grouped_by_where_they_are_bought():
    payload = {
        "iwpNumber": "IWP-88-014",
        "drawings": [{
            "drawingNumber": "LP131-P-108060-04",
            "pipeSchedule": "332",
            "materials": [
                {"description": "PIPE SCH 40 ERW STL A53-B", "commodityCode": "5356648",
                 "nominalSize": "6", "quantity": "49.2'"},
                {"description": "STUD-BOLT A193 GR B8M", "commodityCode": "5676576L",
                 "nominalSize": "3/4", "quantity": "8"},
                {"description": "GASKET 150# PTFE RING", "commodityCode": "5669399L",
                 "nominalSize": "6", "quantity": "2"},
            ],
        }],
    }

    result = takeoff(payload, cwa_override="10D")

    assert result["cwa"] == "10D"
    assert result["counts"][SHEET_PIPE_FITTINGS] == 1
    assert result["counts"][SHEET_BOLTS_GASKETS] == 2
    assert all(row["cwa"] == "10D" and row["iwp"] == "IWP-88-014" for row in result["rows"])


def test_pipe_with_no_schedule_is_reported_because_it_cannot_be_ordered():
    payload = {
        "iwpNumber": "IWP-1",
        "drawings": [{
            "drawingNumber": "D-1-01", "pipeSchedule": "",
            "materials": [{"description": "PIPE SCH 40", "commodityCode": "5356648",
                           "nominalSize": "6", "quantity": "10'"}],
        }],
    }
    assert takeoff(payload)["missingPipeSpec"] == 1
