import json
import sqlite3
from decimal import Decimal
from pathlib import Path

import pytest
from openpyxl import load_workbook

from iso_bom.analytics_app import create_app
from iso_bom.analytics_cli import build_parser
from iso_bom.analytics_manifest import record_run_manifest
from iso_bom.analytics_store import (
    connect_database,
    dashboard_data,
    index_roots,
    legacy_manifest,
    package_detail,
)


PROJECT_ROOT = Path(__file__).resolve().parents[1]
PIPE_FOOTAGE_2_SUMMARY = PROJECT_ROOT / "outputs" / "pipeFootage2" / "pipe_footage_run_summary.json"
LOCAL_OUTPUTS = PROJECT_ROOT / "outputs"
MTO_TEMPLATE = PROJECT_ROOT / "templates" / "MTO" / "Takeoff Spreadsheet Template.xlsx"


def _manifest_run(
    output: Path,
    generated_at: str,
    total: str,
    *,
    status: str = "complete",
    drawing: str = "ISO-001",
) -> Path:
    output.mkdir(parents=True, exist_ok=True)
    artifact = output / f"report-{generated_at[:10]}.docx"
    artifact.write_bytes(b"test artifact")
    summary = {
        "generated_at": generated_at,
        "status": status,
        "iwp_number": "IWP-ANALYTICS-1",
        "input_folder": str(output / "input"),
        "output_folder": str(output),
        "package_total_linear_feet": total,
        "selected_iso_drawings": 1,
        "quarantine_entries": 0,
    }
    path = record_run_manifest(
        output,
        "pipe_footage",
        summary,
        isos=[{
            "drawing_number": drawing,
            "revision": "0",
            "status": "accepted",
            "linear_feet": total,
            "pipe_rows": 1,
            "source_pdf": "package.pdf",
            "source_path": "package.pdf",
            "page": 2,
        }],
        artifacts=[("pipe_report", artifact)],
    )
    return Path(path)


def _mto_manifest_run(
    output: Path,
    generated_at: str,
    scope: str,
    rows: int,
    *,
    partial_rows: int = 0,
) -> Path:
    output.mkdir(parents=True, exist_ok=True)
    suffix = " - BOLTS & GASKETS" if scope == "bolts-gaskets" else ""
    workbook = output / f"MTO IWP-MTO-1{suffix}.xlsx"
    workbook.write_bytes(b"test workbook")
    summary = {
        "generated_at": generated_at,
        "status": "complete",
        "iwp_number": "IWP-MTO-1",
        "cwa": "10D",
        "mto_scope": scope,
        "mto_rows": rows,
        "partial_rows": partial_rows,
        "input_folder": str(output / "input"),
        "output_folder": str(output),
    }
    path = record_run_manifest(
        output,
        "mto",
        summary,
        isos=[{
            "drawing_number": "LP131-PV-941006-03",
            "revision": "0",
            "status": "partial" if partial_rows else "accepted",
            "material_rows": rows,
            "partial_rows": partial_rows,
            "source_pdf": "package.pdf",
            "source_path": "package.pdf",
            "page": 2,
        }],
        artifacts=[("mto_workbook", workbook)],
    )
    return Path(path)


def test_manifest_history_latest_result_and_idempotent_reindex(tmp_path):
    root = tmp_path / "outputs"
    output = root / "pipe"
    _manifest_run(output, "2026-07-20T10:00:00+00:00", "10.10")
    _manifest_run(output, "2026-07-21T10:00:00+00:00", "12.20")
    database = tmp_path / "analytics.sqlite3"
    connection = connect_database(database)
    try:
        first = index_roots(connection, [root])
        second = index_roots(connection, [root])
        assert first["indexed"] == second["indexed"] == 2
        assert connection.execute("SELECT COUNT(*) FROM runs").fetchone()[0] == 2
        data = dashboard_data(connection, {})
        assert data["overview"]["runs"] == 2
        assert data["overview"]["pipe_footage"] == "12.20"
        assert data["overview"]["estimated_time_saved_seconds"] == "42.66"
        assert data["overview"]["time_estimate_runs"] == 1
        assert data["packages"][0]["iso_count"] == 1
        assert data["packages"][0]["estimated_time_saved_seconds"] == "42.66"
        detail = package_detail(connection, "IWP-ANALYTICS-1")
        assert len(detail["runs"]) == 2
        assert [run["is_current"] for run in detail["runs"]] == [True, False]
        index_roots(connection, [root], reindex=True)
        assert connection.execute("SELECT COUNT(*) FROM runs").fetchone()[0] == 2
    finally:
        connection.close()


def test_filters_decimal_aggregation_and_review_status(tmp_path):
    root = tmp_path / "outputs"
    _manifest_run(root / "one", "2026-07-20T10:00:00+00:00", "0.10", drawing="ISO-ALPHA")
    _manifest_run(root / "two", "2026-07-21T10:00:00+00:00", "0.20", drawing="ISO-BETA")
    connection = connect_database(tmp_path / "analytics.sqlite3")
    try:
        index_roots(connection, [root])
        data = dashboard_data(connection, {"q": "ISO-BETA"})
        assert data["overview"]["runs"] == 1
        assert data["overview"]["pipe_footage"] == "0.20"
        assert data["overview"]["estimated_time_saved_seconds"] == "42.66"
        assert data["charts"]["time_saved_by_package"][0]["label"] == "IWP-ANALYTICS-1"
        assert dashboard_data(connection, {"workflow": "fmr"})["overview"]["runs"] == 0
    finally:
        connection.close()


def test_mto_scope_current_runs_filters_register_and_detail(tmp_path):
    root = tmp_path / "outputs"
    output = root / "mto"
    _mto_manifest_run(output, "2026-07-20T10:00:00+00:00", "combined", 3)
    _mto_manifest_run(output, "2026-07-21T10:00:00+00:00", "combined", 5, partial_rows=1)
    _mto_manifest_run(output, "2026-07-22T10:00:00+00:00", "bolts-gaskets", 7)
    connection = connect_database(tmp_path / "analytics.sqlite3")
    try:
        index_roots(connection, [root])
        data = dashboard_data(connection, {})
        assert data["overview"]["mto_workbooks"] == 2
        assert data["overview"]["mto_rows"] == 12
        assert data["overview"]["partial_rows"] == 1
        assert data["overview"]["cwas"] == 1
        assert {row["mto_scope"] for row in data["mto_register"]} == {
            "combined", "bolts-gaskets"
        }
        assert all(row["workbook"]["exists_flag"] for row in data["mto_register"])
        assert dashboard_data(connection, {"cwa": "10D"})["overview"]["runs"] == 3
        assert dashboard_data(connection, {"q": "10D"})["overview"]["runs"] == 3
        bolts = dashboard_data(connection, {"mto_scope": "bolts-gaskets"})
        assert bolts["overview"]["runs"] == 1
        assert bolts["overview"]["mto_rows"] == 7

        detail = package_detail(connection, "IWP-MTO-1")
        assert [run["is_current"] for run in detail["runs"]] == [True, True, False]
        assert detail["runs"][0]["mto_scope"] == "bolts-gaskets"
        assert detail["runs"][0]["isos"][0]["material_rows"] == 7
    finally:
        connection.close()

    app = create_app([root], tmp_path / "api-analytics.sqlite3", reindex=True)
    client = app.test_client()
    response = client.get("/api/dashboard?cwa=10D&mto_scope=bolts-gaskets")
    assert response.status_code == 200
    payload = response.get_json()
    assert len(payload["mto_register"]) == 1
    artifact_id = payload["mto_register"][0]["workbook"]["id"]
    assert client.get(f"/artifact/{artifact_id}").status_code == 200


def test_malformed_manifest_is_reported_without_stopping_index(tmp_path):
    root = tmp_path / "outputs"
    good = _manifest_run(root / "good", "2026-07-21T10:00:00+00:00", "1.0")
    bad_dir = root / "bad" / "analytics_runs"
    bad_dir.mkdir(parents=True)
    (bad_dir / "broken.json").write_text("{not json")
    connection = connect_database(tmp_path / "analytics.sqlite3")
    try:
        result = index_roots(connection, [root])
        assert result["indexed"] == 1
        assert len(result["errors"]) == 1
        assert str(good) not in result["errors"][0]
    finally:
        connection.close()


def test_missing_fmr_timing_evidence_and_review_pipe_are_not_estimated(tmp_path):
    root = tmp_path / "outputs"
    manifest_dir = root / "fmr" / "analytics_runs"
    manifest_dir.mkdir(parents=True)
    payload = {
        "schema_version": "1.0",
        "run_id": "old-fmr",
        "workflow": "fmr",
        "generated_at": "2026-07-21T10:00:00+00:00",
        "status": "complete",
        "package_number": "IWP-MISSING-EVIDENCE",
        "input_folder": "",
        "output_folder": str(root / "fmr"),
        "metrics": {"fmr_sheets_created": 1},
        "isos": [{
            "drawing_number": "ISO-OLD", "revision": "0", "status": "accepted",
            "material_rows": 1, "source_pdf": "", "source_path": "", "page": 1,
        }],
        "issues": [],
        "artifacts": [],
    }
    (manifest_dir / "old.json").write_text(json.dumps(payload))
    _manifest_run(
        root / "pipe-review", "2026-07-21T11:00:00+00:00", "5.0",
        status="review_required", drawing="ISO-REVIEW",
    )

    connection = connect_database(tmp_path / "analytics.sqlite3")
    try:
        index_roots(connection, [root])
        missing = package_detail(connection, "IWP-MISSING-EVIDENCE")["runs"][0]
        assert missing["time_estimate_available"] == 0
        assert missing["estimated_time_saved_seconds"] is None
        summary = json.loads(missing["summary_json"])
        assert summary["time_estimate_reason"] == "missing_timing_evidence"
        review = dashboard_data(connection, {"status": "review_required"})
        assert review["overview"]["time_estimate_available"] is False
        assert review["charts"]["time_saved_by_package"] == []
    finally:
        connection.close()


def test_dashboard_api_artifact_allowlist_and_security_headers(tmp_path):
    root = tmp_path / "outputs"
    manifest_path = _manifest_run(root / "pipe", "2026-07-21T10:00:00+00:00", "5.5")
    payload = json.loads(manifest_path.read_text())
    outside = tmp_path / "outside.txt"
    outside.write_text("secret")
    payload["artifacts"].append({"kind": "outside", "name": outside.name, "path": str(outside)})
    manifest_path.write_text(json.dumps(payload))
    app = create_app([root], tmp_path / "analytics.sqlite3", reindex=True)
    client = app.test_client()

    response = client.get("/api/dashboard")
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    assert "default-src 'self'" in response.headers["Content-Security-Policy"]
    detail = client.get("/api/package?number=IWP-ANALYTICS-1").get_json()
    assert detail["runs"][0]["estimated_time_saved_seconds"] == "42.66"
    assert detail["runs"][0]["time_saved_breakdown"]["selected_iso_count"] == 1
    artifacts = detail["runs"][0]["artifacts"]
    inside_id = next(item["id"] for item in artifacts if item["kind"] == "pipe_report")
    outside_id = next(item["id"] for item in artifacts if item["kind"] == "outside")
    assert client.get(f"/artifact/{inside_id}").status_code == 200
    assert client.get(f"/artifact/{outside_id}").status_code == 403
    assert client.get("/api/health", headers={"Host": "example.com"}).status_code == 403
    page = client.get("/")
    assert page.status_code == 200
    assert b'id="kpi-time-saved"' in page.data
    assert b'id="kpi-processing"' in page.data
    assert b'id="kpi-mto-rows"' in page.data
    assert b'id="mto-rows"' in page.data
    assert b'id="time-chart"' in page.data
    assert b'<details class="methodology panel">' in page.data


def test_two_database_connections_respect_wal_and_busy_timeout(tmp_path):
    path = tmp_path / "analytics.sqlite3"
    first = connect_database(path)
    second = connect_database(path)
    try:
        assert first.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"
        assert second.execute("PRAGMA busy_timeout").fetchone()[0] == 10000
        assert first.execute("PRAGMA user_version").fetchone()[0] == 3
    finally:
        first.close()
        second.close()


def test_cli_rejects_non_loopback_host():
    parser = build_parser()
    with pytest.raises(SystemExit):
        parser.parse_args(["--root", ".", "--host", "0.0.0.0"])


def test_schema_v1_database_migrates_without_losing_rows(tmp_path):
    path = tmp_path / "analytics.sqlite3"
    connection = sqlite3.connect(path)
    connection.executescript(
        """
        CREATE TABLE runs (
            run_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE,
            workflow TEXT NOT NULL, generated_at TEXT NOT NULL, status TEXT NOT NULL,
            package_number TEXT NOT NULL DEFAULT '', input_folder TEXT NOT NULL DEFAULT '',
            output_folder TEXT NOT NULL DEFAULT '', package_total_lf TEXT,
            fmr_sheets INTEGER NOT NULL DEFAULT 0, accepted_records INTEGER NOT NULL DEFAULT 0,
            iso_count INTEGER NOT NULL DEFAULT 0, review_count INTEGER NOT NULL DEFAULT 0,
            summary_json TEXT NOT NULL, manifest_path TEXT NOT NULL,
            imported_legacy INTEGER NOT NULL DEFAULT 0, indexed_at TEXT NOT NULL
        );
        CREATE TABLE isos (
            id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL,
            drawing_number TEXT NOT NULL, revision TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'accepted', linear_feet TEXT,
            pipe_rows INTEGER NOT NULL DEFAULT 0, material_rows INTEGER NOT NULL DEFAULT 0,
            source_pdf TEXT NOT NULL DEFAULT '', source_path TEXT NOT NULL DEFAULT '',
            page INTEGER NOT NULL DEFAULT 0,
            UNIQUE(run_id, drawing_number, revision, page)
        );
        PRAGMA user_version = 1;
        INSERT INTO runs VALUES (
            'run-1', 'fingerprint-1', 'fmr', '2026-07-21T00:00:00+00:00',
            'complete', 'IWP-1', '', '', NULL, 1, 0, 1, 0, '{}', 'legacy.json', 1, 'now'
        );
        """
    )
    connection.close()

    migrated = connect_database(path)
    try:
        assert migrated.execute("PRAGMA user_version").fetchone()[0] == 3
        assert migrated.execute("SELECT package_number FROM runs").fetchone()[0] == "IWP-1"
        columns = {row[1] for row in migrated.execute("PRAGMA table_info(runs)")}
        assert {
            "processing_seconds", "estimated_time_saved_seconds", "time_model_version",
            "cwa", "mto_scope", "mto_rows", "partial_rows",
        } <= columns
    finally:
        migrated.close()


def test_legacy_mto_summary_backfills_scope_cwa_rows_and_isos(tmp_path):
    workbook_path = tmp_path / "MTO IWP-LEGACY.xlsx"
    workbook = load_workbook(MTO_TEMPLATE)
    sheet = workbook["COMBINED"]
    for column, value in zip(
        ("A", "B", "C", "D", "E", "F", "G", "I", "J", "K"),
        ("10D", "IWP-LEGACY", "LP131-PV-941006-03", 3, 315, "BIRDSCREEN", 4, "BS-1", 2, "EA"),
    ):
        sheet[f"{column}2"] = value
    workbook.save(workbook_path)
    workbook.close()
    summary_path = tmp_path / "mto_run_summary.json"
    summary_path.write_text(json.dumps({
        "generated_at": "2026-07-21T10:00:00+00:00",
        "status": "complete",
        "iwp_number": "IWP-LEGACY",
        "cwa": "10D",
        "workbook": str(workbook_path),
        "mto_rows_created": 1,
    }))

    manifest = legacy_manifest(summary_path)
    assert manifest["workflow"] == "mto"
    assert manifest["mto_scope"] == "combined"
    assert manifest["cwa"] == "10D"
    assert manifest["isos"][0]["drawing_number"] == "LP131-PV-941006-03"
    assert manifest["isos"][0]["material_rows"] == 1


@pytest.mark.skipif(
    not PIPE_FOOTAGE_2_SUMMARY.exists(),
    reason="Local pipeFootage2 output is unavailable",
)
def test_legacy_pipe_output_imports_package_isos_and_exact_total():
    manifest = legacy_manifest(PIPE_FOOTAGE_2_SUMMARY)
    assert manifest["workflow"] == "pipe_footage"
    assert manifest["package_number"] == "IP-SMM30R117MMPP-K447"
    assert len(manifest["isos"]) == 8
    assert manifest["metrics"]["package_total_linear_feet"] == "182.3"
    assert manifest["metrics"]["estimated_time_saved_seconds"] == "98.66"


@pytest.mark.skipif(
    not LOCAL_OUTPUTS.exists(),
    reason="Local saved outputs are unavailable",
)
def test_local_outputs_backfill_expected_time_saved_totals(tmp_path):
    connection = connect_database(tmp_path / "analytics.sqlite3")
    try:
        result = index_roots(connection, [LOCAL_OUTPUTS])
        assert result["errors"] == []
        all_data = dashboard_data(connection, {})
        fmr_data = dashboard_data(connection, {"workflow": "fmr"})
        pipe_data = dashboard_data(connection, {"workflow": "pipe_footage"})
        assert fmr_data["overview"]["fmr_sheets"] > 0
        assert Decimal(fmr_data["overview"]["estimated_time_saved_seconds"]) > 0
        assert pipe_data["overview"]["isos"] > 0
        assert Decimal(pipe_data["overview"]["estimated_time_saved_seconds"]) > 0
        assert Decimal(all_data["overview"]["estimated_time_saved_seconds"]) == (
            Decimal(fmr_data["overview"]["estimated_time_saved_seconds"])
            + Decimal(pipe_data["overview"]["estimated_time_saved_seconds"])
        )
    finally:
        connection.close()
