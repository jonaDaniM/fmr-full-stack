import csv
import json
import re
from collections import defaultdict
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from time import perf_counter
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

import fitz

from .analytics_manifest import record_run_manifest
from .fmr_model import QUARANTINE_FIELDS, QuarantineEntry
from .fmr_parser import (
    extract_iwp_number,
    is_contextual_attachment_image_run,
    is_fmr_attachment_page,
    is_iso_page,
    is_iwp_cover_page,
    is_logistics_page,
    is_pipe_support_page,
    is_weld_log_page,
    normalize_text,
    page_quarantine,
)
from .pipe_model import PIPE_AUDIT_FIELDS, PipeAuditRow, PipeIsoPage
from .pipe_parser import parse_pipe_iso_page
from .pipe_report import build_pipe_footage_report
from .pipeline import discover_pdfs
from .time_savings import pipe_iso_time_saved, pipe_time_estimate, processing_seconds


INVALID_FILENAME_CHARS = re.compile(r'[<>:"/\\|?*]')


def report_filename(iwp_number: str) -> str:
    if not iwp_number or INVALID_FILENAME_CHARS.search(iwp_number):
        raise ValueError(f"IWP number cannot be used in an output filename: {iwp_number!r}")
    return f"{iwp_number}_PIPE_FOOTAGE.docx"


def _raw_excerpt(text: str) -> str:
    return " ".join(text.split())[:1000]


def _quarantine_iso(
    iso: PipeIsoPage,
    iwp_number: str,
    reason_code: str,
    reason_detail: str,
) -> QuarantineEntry:
    return QuarantineEntry(
        source_pdf=iso.source_pdf,
        source_path=iso.source_path,
        page=iso.page,
        iwp_number=iwp_number,
        isometric_drawing_number=iso.drawing_number,
        revision=iso.revision,
        reason_code=reason_code,
        reason_detail=reason_detail,
        raw_text=_raw_excerpt(iso.raw_text),
    )


def _package_quarantine(
    iwp_number: str,
    reason_code: str,
    reason_detail: str,
) -> QuarantineEntry:
    return QuarantineEntry(
        source_pdf="",
        source_path="",
        page=0,
        iwp_number=iwp_number,
        reason_code=reason_code,
        reason_detail=reason_detail,
    )


def _write_csv(path: Path, fields: Sequence[str], rows: Iterable[Dict[str, object]]) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def _write_outputs(
    output_dir: Path,
    summary: Dict[str, object],
    audit_rows: Sequence[PipeAuditRow],
    quarantine: Sequence[QuarantineEntry],
    iso_pages: Sequence[PipeIsoPage] = (),
    processing_started_at: Optional[float] = None,
) -> None:
    estimate_available = summary.get("status") == "complete" and bool(summary.get("report"))
    summary.update(pipe_time_estimate(len(iso_pages), eligible=estimate_available))
    if processing_started_at is not None:
        summary["processing_seconds"] = processing_seconds(processing_started_at)
    output_dir.mkdir(parents=True, exist_ok=True)
    _write_csv(
        output_dir / "pipe_footage_audit.csv",
        PIPE_AUDIT_FIELDS,
        (row.dict() for row in audit_rows),
    )
    _write_csv(
        output_dir / "pipe_footage_quarantine.csv",
        QUARANTINE_FIELDS,
        (entry.dict() for entry in quarantine),
    )
    summary_path = output_dir / "pipe_footage_run_summary.json"
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    artifact_paths = [
        ("pipe_audit", output_dir / "pipe_footage_audit.csv"),
        ("quarantine", output_dir / "pipe_footage_quarantine.csv"),
        ("run_summary", summary_path),
    ]
    report = str(summary.get("report") or "")
    if report:
        artifact_paths.insert(0, ("pipe_report", Path(report)))
    iso_payload = []
    for iso in iso_pages:
        total = iso.total_linear_feet
        iso_payload.append({
            "drawing_number": iso.drawing_number,
            "revision": iso.revision,
            "status": "review" if iso.review_reasons or total is None else "accepted",
            "linear_feet": "" if total is None else str(total),
            "pipe_rows": len(iso.pipe_measurements),
            "material_rows": 0,
            "overflow_material_rows": 0,
            "estimated_time_saved_seconds": (
                pipe_iso_time_saved() if estimate_available else None
            ),
            "source_pdf": iso.source_pdf,
            "source_path": iso.source_path,
            "page": iso.page,
        })
    record_run_manifest(
        output_dir,
        "pipe_footage",
        summary,
        isos=iso_payload,
        issues=quarantine,
        artifacts=artifact_paths,
    )
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")


def _scan_pdfs(
    input_dir: Path,
    pdfs: Sequence[Path],
) -> Tuple[List[str], List[PipeIsoPage], List[QuarantineEntry], Dict[str, int]]:
    iwp_numbers: List[str] = []
    iso_pages: List[PipeIsoPage] = []
    quarantine: List[QuarantineEntry] = []
    counts = {
        "pages": 0,
        "covers": 0,
        "weld_logs": 0,
        "pipe_supports": 0,
        "attachment_images": 0,
        "fmr_attachments": 0,
        "logistics": 0,
        "other_non_iso": 0,
    }

    for pdf in pdfs:
        relative = pdf.relative_to(input_dir).as_posix()
        try:
            document = fitz.open(pdf)
        except Exception as exc:
            quarantine.append(page_quarantine(
                pdf, relative, 0, "pdf_open_error", f"{type(exc).__name__}: {exc}", ""
            ))
            continue
        try:
            page_texts = [page.get_text("text") or "" for page in document]
            for index in range(document.page_count):
                page_number = index + 1
                page = document[index]
                counts["pages"] += 1
                text = page_texts[index]
                if is_contextual_attachment_image_run(document, index, page_texts):
                    counts["attachment_images"] += 1
                    continue
                if len(text.strip()) < 40:
                    quarantine.append(page_quarantine(
                        pdf, relative, page_number, "ocr_required",
                        "Page has insufficient native text for reliable extraction", text,
                    ))
                    continue
                if is_iso_page(text):
                    iso_pages.append(parse_pipe_iso_page(
                        page, page_number, pdf.name, relative
                    ))
                    continue
                if is_iwp_cover_page(text):
                    counts["covers"] += 1
                    iwp_number, reasons = extract_iwp_number(page)
                    if reasons:
                        quarantine.append(page_quarantine(
                            pdf, relative, page_number, "iwp_cover_ambiguous",
                            ";".join(reasons), text,
                        ))
                    else:
                        iwp_numbers.append(iwp_number)
                    continue
                if is_weld_log_page(text):
                    counts["weld_logs"] += 1
                    continue
                if is_pipe_support_page(text):
                    counts["pipe_supports"] += 1
                    continue
                if is_fmr_attachment_page(text):
                    counts["fmr_attachments"] += 1
                    continue
                if is_logistics_page(text):
                    counts["logistics"] += 1
                    continue

                normalized = normalize_text(text)
                if "INSTALLATION WORK PACKAGE" in normalized:
                    code = "iwp_cover_ambiguous"
                    reason = "Installation Work Package page did not contain a readable IWP Number"
                elif "ISOMETRIC DRAWING NUMBER" in normalized or "BILL OF MATERIALS" in normalized:
                    code = "partial_iso_structure"
                    reason = "Page contains only part of the required ISO/BOM structure"
                else:
                    counts["other_non_iso"] += 1
                    continue
                quarantine.append(page_quarantine(
                    pdf, relative, page_number, code, reason, text,
                ))
        except Exception as exc:
            quarantine.append(page_quarantine(
                pdf, relative, 0, "pdf_processing_error",
                f"{type(exc).__name__}: {exc}", "",
            ))
        finally:
            document.close()
    return iwp_numbers, iso_pages, quarantine, counts


def _select_revisions(
    pages: Sequence[PipeIsoPage],
    iwp_number: str,
) -> Tuple[List[PipeIsoPage], List[QuarantineEntry], int, int, int]:
    quarantine: List[QuarantineEntry] = []
    grouped: Dict[str, List[PipeIsoPage]] = defaultdict(list)
    for iso in pages:
        if not iso.drawing_number or not iso.revision:
            quarantine.append(_quarantine_iso(
                iso, iwp_number, "iso_identity_ambiguous", ";".join(iso.review_reasons)
            ))
            continue
        grouped[iso.drawing_number].append(iso)

    selected_pages: List[PipeIsoPage] = []
    superseded = 0
    duplicate = 0
    for drawing_number, drawing_pages in grouped.items():
        revisions = sorted(set(page.revision for page in drawing_pages))
        if len(revisions) > 1 and not all(revision.isdigit() for revision in revisions):
            for iso in drawing_pages:
                quarantine.append(_quarantine_iso(
                    iso, iwp_number, "unorderable_multiple_revisions",
                    f"Drawing has revisions: {', '.join(revisions)}",
                ))
            continue

        if all(revision.isdigit() for revision in revisions):
            highest = max(int(revision) for revision in revisions)
            candidates = [iso for iso in drawing_pages if int(iso.revision) == highest]
        else:
            candidates = list(drawing_pages)
        superseded += len(drawing_pages) - len(candidates)

        hashes = {iso.content_hash for iso in candidates}
        if len(hashes) > 1:
            for iso in candidates:
                quarantine.append(_quarantine_iso(
                    iso, iwp_number, "duplicate_revision_conflict",
                    "Multiple pages have the same drawing revision but different BOM content",
                ))
            continue
        candidates.sort(key=lambda iso: iso.order_key)
        chosen = candidates[0]
        duplicate += len(candidates) - 1
        if chosen.review_reasons:
            quarantine.append(_quarantine_iso(
                chosen, iwp_number, "iso_parse_ambiguous", ";".join(chosen.review_reasons)
            ))
        selected_pages.append(chosen)

    selected_pages.sort(key=lambda iso: iso.order_key)
    return selected_pages, quarantine, superseded, duplicate, len(grouped)


def _audit_rows(iwp_number: str, pages: Sequence[PipeIsoPage]) -> List[PipeAuditRow]:
    result: List[PipeAuditRow] = []
    for iso in pages:
        for item in iso.pipe_measurements:
            row = item.row
            reasons = sorted(set(iso.review_reasons + item.review_reasons))
            feet = "" if item.linear_feet is None else f"{item.linear_feet:.{item.precision}f}"
            result.append(PipeAuditRow(
                iwp_number=iwp_number,
                source_pdf=iso.source_pdf,
                source_path=iso.source_path,
                page=iso.page,
                isometric_drawing_number=iso.drawing_number,
                revision=iso.revision,
                point_number=row.point_number,
                description=row.description,
                nominal_size=row.nominal_size,
                commodity_code=row.commodity_code,
                quantity=row.quantity,
                linear_feet=feet,
                raw_text=row.raw_text,
                bbox_x0=round(row.bbox[0], 2),
                bbox_y0=round(row.bbox[1], 2),
                bbox_x1=round(row.bbox[2], 2),
                bbox_y1=round(row.bbox[3], 2),
                status="review" if reasons else "accepted",
                review_reasons=";".join(reasons),
            ))
    return result


def _base_summary(input_dir: Path, output_dir: Path, pdf_count: int) -> Dict[str, object]:
    return {
        "schema_version": "1.0",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "status": "complete",
        "input_folder": str(input_dir),
        "output_folder": str(output_dir),
        "pdfs_discovered": pdf_count,
        "pages_scanned": 0,
        "cover_pages_detected": 0,
        "iso_pages_detected": 0,
        "unique_drawings": 0,
        "selected_iso_drawings": 0,
        "weld_log_pages_ignored": 0,
        "pipe_support_pages_ignored": 0,
        "attachment_image_pages_ignored": 0,
        "fmr_attachment_pages_ignored": 0,
        "logistics_pages_ignored": 0,
        "other_non_iso_pages_ignored": 0,
        "superseded_pages_ignored": 0,
        "duplicate_pages_ignored": 0,
        "pipe_bom_rows": 0,
        "package_total_linear_feet": None,
        "quarantine_entries": 0,
        "iwp_number": "",
        "report": "",
        "production_ready": False,
        "manual_comparison_required": True,
    }


def run_pipe_footage(
    input_dir: Path,
    output_dir: Path,
    overwrite: bool = False,
    iwp_number_override: Optional[str] = None,
) -> Dict[str, object]:
    processing_started_at = perf_counter()
    input_dir = input_dir.resolve()
    output_dir = output_dir.resolve()
    if not input_dir.is_dir():
        raise ValueError(f"Input folder does not exist or is not a directory: {input_dir}")
    if input_dir == output_dir:
        raise ValueError("Input and output folders must be different")

    pdfs = discover_pdfs(input_dir)
    summary = _base_summary(input_dir, output_dir, len(pdfs))
    iwp_candidates, iso_pages, quarantine, counts = _scan_pdfs(input_dir, pdfs)
    summary.update({
        "pages_scanned": counts["pages"],
        "cover_pages_detected": counts["covers"],
        "iso_pages_detected": len(iso_pages),
        "weld_log_pages_ignored": counts["weld_logs"],
        "pipe_support_pages_ignored": counts["pipe_supports"],
        "attachment_image_pages_ignored": counts["attachment_images"],
        "fmr_attachment_pages_ignored": counts["fmr_attachments"],
        "logistics_pages_ignored": counts["logistics"],
        "other_non_iso_pages_ignored": counts["other_non_iso"],
    })

    override_iwp = (iwp_number_override or "").strip()
    unique_iwps = sorted(set(iwp_candidates))
    if override_iwp:
        if unique_iwps and unique_iwps != [override_iwp]:
            detail = (
                f"Manual IWP number {override_iwp} conflicts with detected "
                f"IWP numbers: {', '.join(unique_iwps)}"
            )
            shown_iwp = ";".join(dict.fromkeys([override_iwp] + unique_iwps))
            quarantine.append(_package_quarantine(
                shown_iwp, "manual_iwp_conflict", detail
            ))
            summary.update({
                "status": "blocked", "iwp_number": shown_iwp,
                "quarantine_entries": len(quarantine),
            })
            _write_outputs(
                output_dir, summary, [], quarantine, iso_pages, processing_started_at
            )
            return summary
        unique_iwps = [override_iwp]

    if len(unique_iwps) != 1:
        reason_code = "iwp_missing" if not unique_iwps else "multiple_iwp_numbers"
        detail = (
            "No unambiguous IWP number was found"
            if not unique_iwps
            else f"Conflicting IWP numbers were found: {', '.join(unique_iwps)}"
        )
        shown_iwp = ";".join(unique_iwps)
        quarantine.append(_package_quarantine(
            shown_iwp, reason_code, detail
        ))
        summary.update({
            "status": "blocked", "iwp_number": shown_iwp,
            "quarantine_entries": len(quarantine),
        })
        _write_outputs(
            output_dir, summary, [], quarantine, iso_pages, processing_started_at
        )
        return summary

    iwp_number = unique_iwps[0]
    summary["iwp_number"] = iwp_number
    for entry in quarantine:
        if not entry.iwp_number:
            entry.iwp_number = iwp_number

    if not iso_pages:
        quarantine.append(QuarantineEntry(
            source_pdf="", source_path="", page=0, iwp_number=iwp_number,
            reason_code="no_iso_pages", reason_detail="No ISO pages were detected in the package",
        ))
        summary.update({"status": "blocked", "quarantine_entries": len(quarantine)})
        _write_outputs(
            output_dir, summary, [], quarantine, iso_pages, processing_started_at
        )
        return summary

    selected, revision_quarantine, superseded, duplicate, unique_drawings = _select_revisions(
        iso_pages, iwp_number
    )
    quarantine.extend(revision_quarantine)
    summary.update({
        "unique_drawings": unique_drawings,
        "selected_iso_drawings": len(selected),
        "superseded_pages_ignored": superseded,
        "duplicate_pages_ignored": duplicate,
    })

    audit_rows = _audit_rows(iwp_number, selected)
    summary["pipe_bom_rows"] = len(audit_rows)
    status = "review_required" if quarantine else "complete"
    package_precision = max((iso.precision for iso in selected), default=1)
    totals = [iso.total_linear_feet for iso in selected]
    package_total = None
    if status == "complete" and all(total is not None for total in totals):
        package_total = sum((total for total in totals if total is not None), Decimal("0"))
        summary["package_total_linear_feet"] = f"{package_total:.{package_precision}f}"
    else:
        status = "review_required"
    summary["status"] = status
    summary["quarantine_entries"] = len(quarantine)

    filename = report_filename(iwp_number)
    report_path = output_dir / filename
    build_pipe_footage_report(
        report_path,
        iwp_number,
        selected,
        status,
        str(summary["generated_at"]),
        quarantine,
        package_total,
        package_precision,
        overwrite=overwrite,
    )
    summary["report"] = str(report_path)
    _write_outputs(
        output_dir, summary, audit_rows, quarantine, selected, processing_started_at
    )
    return summary
