import csv
import json
from pathlib import Path

import fitz

from iso_bom.pipeline import run


def _fabricated_pdf(path: Path, include_targets: bool = True) -> None:
    doc = fitz.open()
    page = doc.new_page(width=792, height=612)
    y = 40
    page.insert_text((420, y), "BILL OF MATERIALS")
    y += 25
    for x, text in [(420, "PT"), (455, "DESCRIPTION"), (610, "NPD"), (660, "CMDTY"), (745, "QTY")]:
        page.insert_text((x, y), text, fontsize=8)
    rows = [("1", "PIPE STD WT", "4", "111", "10")]
    if include_targets:
        rows += [("2", "GASKET 150# PTFE RING", "4", "G-001", "2"), ("3", "STUD-BOLT A193 GR B7", "5/8", "B-001", "8")]
    for row in rows:
        y += 25
        for x, text in zip((420, 455, 610, 660, 745), row):
            page.insert_text((x, y), text, fontsize=8)
    doc.save(path)
    doc.close()


def test_pipeline_writes_contract_and_traceability(tmp_path):
    source, output = tmp_path / "input", tmp_path / "output"
    source.mkdir()
    _fabricated_pdf(source / "fabricated.pdf")
    summary = run(source, output)
    expected = {"bolts_raw.csv", "gaskets_raw.csv", "bolts_clean.csv", "gaskets_clean.csv", "review_required.csv", "combined_takeoff.csv", "pdf_extraction_audit.json", "run_summary.json", "analytics_runs"}
    assert {p.name for p in output.iterdir()} == expected
    assert summary["bolt_records_raw"] == summary["gasket_records_raw"] == 1
    with (output / "combined_takeoff.csv").open() as handle:
        rows = list(csv.DictReader(handle))
    assert len(rows) == 2
    assert all(r["source_pdf"] == "fabricated.pdf" and r["page"] == "1" and r["raw_text"] and r["bbox_x0"] for r in rows)
    manifests = list((output / "analytics_runs").glob("*.json"))
    assert len(manifests) == 1
    manifest = json.loads(manifests[0].read_text())
    assert manifest["workflow"] == "bolt_gasket"
    assert [item["drawing_number"] for item in manifest["isos"]] == ["fabricated"]


def test_no_target_pdf_is_flagged(tmp_path):
    source, output = tmp_path / "input", tmp_path / "output"
    source.mkdir()
    _fabricated_pdf(source / "no_targets.pdf", include_targets=False)
    summary = run(source, output)
    assert summary["pdfs_with_neither_target"] == 1
    with (output / "review_required.csv").open() as handle:
        reviews = list(csv.DictReader(handle))
    assert reviews[0]["review_type"] == "pdf_no_target_materials"
    assert reviews[0]["review_reasons"] == "pdf_has_neither_bolts_nor_gaskets"
