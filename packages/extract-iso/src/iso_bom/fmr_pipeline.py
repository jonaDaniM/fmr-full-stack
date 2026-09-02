import csv
import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from time import perf_counter
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

import fitz
from openpyxl import load_workbook

from .analytics_manifest import record_run_manifest
from .fmr_model import (
    IsoPage,
    QUARANTINE_FIELDS,
    QuarantineEntry,
    material_review_reasons,
)
from .fmr_parser import (
    extract_iwp_number,
    is_contextual_attachment_image_run,
    is_fmr_attachment_page,
    is_iso_workflow_status_page,
    is_iso_page,
    is_iwp_cover_page,
    is_logistics_page,
    is_pipe_material,
    is_pipe_support_page,
    is_weld_log_page,
    normalize_text,
    page_quarantine,
    parse_iso_page,
)
from .fmr_workbook import (
    build_fmr_workbook,
    sheet_names,
    workbook_filename,
)
from .pipeline import discover_pdfs
from .spool_model import spool_sort_key
from .time_savings import (
    fmr_iso_time_saved,
    fmr_time_estimate,
    is_overflow_description,
    processing_seconds,
)


DEFAULT_TEMPLATE = Path(__file__).resolve().parents[2] / "templates" / "FMR" / "blankFMR.xlsx"
FMR_WORKBOOK_SUFFIX = "_FMR.xlsx"
SPOOL_REVIEW_CODES = {
    "no_spool_number_detected",
    "spool_number_candidate",
    "spool_number_duplicate_conflict",
}
MATERIAL_REVIEW_CODE = "material_line_review"


def _raw_excerpt(text: str) -> str:
    return " ".join(text.split())[:1000]


def _quarantine_iso(
    iso: IsoPage,
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


def _quarantine_material(
    iso: IsoPage,
    iwp_number: str,
    material,
    reasons: Sequence[str],
) -> QuarantineEntry:
    point = str(material.point_number or "?").strip() or "?"
    detail = (
        f"BOM point {point} was written to the FMR and requires review: "
        f"{';'.join(reasons)}"
    )
    return QuarantineEntry(
        source_pdf=iso.source_pdf,
        source_path=iso.source_path,
        page=iso.page,
        iwp_number=iwp_number,
        isometric_drawing_number=iso.drawing_number,
        revision=iso.revision,
        reason_code=MATERIAL_REVIEW_CODE,
        reason_detail=detail,
        raw_text=_raw_excerpt(material.raw_text),
    )


def _write_quarantine(path: Path, entries: Iterable[QuarantineEntry]) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=QUARANTINE_FIELDS)
        writer.writeheader()
        writer.writerows(entry.dict() for entry in entries)


def _write_auxiliary_outputs(
    output_dir: Path,
    summary: Dict[str, object],
    quarantine: Sequence[QuarantineEntry],
    iso_pages: Sequence[IsoPage] = (),
    processing_started_at: Optional[float] = None,
) -> None:
    material_rows = sum(len(iso.materials) for iso in iso_pages)
    overflow_rows = sum(
        is_overflow_description(material.description)
        for iso in iso_pages
        for material in iso.materials
    )
    summary.update(fmr_time_estimate(
        len(iso_pages),
        material_rows,
        overflow_rows,
        eligible=(summary.get("status") == "complete" and bool(summary.get("workbook"))),
    ))
    if processing_started_at is not None:
        summary["processing_seconds"] = processing_seconds(processing_started_at)
    output_dir.mkdir(parents=True, exist_ok=True)
    quarantine_path = output_dir / "fmr_quarantine.csv"
    summary_path = output_dir / "fmr_run_summary.json"
    _write_quarantine(quarantine_path, quarantine)
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    artifact_paths = [
        ("quarantine", quarantine_path),
        ("run_summary", summary_path),
    ]
    workbook = str(summary.get("workbook") or "")
    if workbook:
        artifact_paths.insert(0, ("fmr_workbook", Path(workbook)))
    iso_payload = []
    for iso in iso_pages:
        iso_pipe_rows = sum(
            is_pipe_material(material) for material in iso.materials
        )
        iso_overflow_rows = sum(
            is_overflow_description(material.description) for material in iso.materials
        )
        iso_payload.append({
            "drawing_number": iso.drawing_number,
            "revision": iso.revision,
            "status": "review" if (
                iso.review_reasons
                or iso.spool_review_reasons
                or any(material_review_reasons(row) for row in iso.materials)
            ) else "accepted",
            "linear_feet": "",
            "pipe_rows": iso_pipe_rows,
            "spool_rows": len(iso.spool_numbers),
            "material_rows": len(iso.materials),
            "material_review_rows": sum(
                bool(material_review_reasons(row)) for row in iso.materials
            ),
            "overflow_material_rows": iso_overflow_rows,
            "estimated_time_saved_seconds": fmr_iso_time_saved(
                len(iso.materials), iso_overflow_rows
            ),
            "source_pdf": iso.source_pdf,
            "source_path": iso.source_path,
            "page": iso.page,
        })
    record_run_manifest(
        output_dir,
        "fmr",
        summary,
        isos=iso_payload,
        issues=quarantine,
        artifacts=artifact_paths,
    )
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")


def _iwp_from_header_cell(value: object) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    if text.upper().startswith("IWP:"):
        return text.split(":", 1)[1].strip()
    return ""


def _iwp_from_existing_fmr_workbook(path: Path) -> str:
    filename_iwp = (
        path.name[:-len(FMR_WORKBOOK_SUFFIX)]
        if path.name.endswith(FMR_WORKBOOK_SUFFIX)
        else ""
    )
    try:
        workbook = load_workbook(path, read_only=True, data_only=True)
    except Exception:
        return ""
    try:
        header_iwps = {
            iwp
            for worksheet in workbook.worksheets
            for iwp in [_iwp_from_header_cell(worksheet["H5"].value)]
            if iwp
        }
    finally:
        workbook.close()

    if len(header_iwps) == 1:
        header_iwp = next(iter(header_iwps))
        if not filename_iwp or filename_iwp == header_iwp:
            return header_iwp
    if not header_iwps and filename_iwp:
        return filename_iwp
    return ""


def _iwp_from_existing_output_workbook(output_dir: Path) -> str:
    if not output_dir.is_dir():
        return ""
    workbooks = sorted(
        path
        for path in output_dir.glob(f"*{FMR_WORKBOOK_SUFFIX}")
        if path.is_file() and not path.name.startswith("~$")
    )
    if len(workbooks) != 1:
        return ""
    return _iwp_from_existing_fmr_workbook(workbooks[0])


def _base_summary(
    input_dir: Path,
    output_dir: Path,
    template_path: Path,
    pdf_count: int,
) -> Dict[str, object]:
    return {
        "schema_version": "1.0",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "status": "complete",
        "input_folder": str(input_dir),
        "output_folder": str(output_dir),
        "template": str(template_path),
        "pdfs_discovered": pdf_count,
        "pages_scanned": 0,
        "cover_pages_detected": 0,
        "iso_pages_detected": 0,
        "unique_drawings": 0,
        "weld_log_pages_ignored": 0,
        "pipe_support_pages_ignored": 0,
        "attachment_image_pages_ignored": 0,
        "fmr_attachment_pages_ignored": 0,
        "logistics_pages_ignored": 0,
        "other_non_iso_pages_ignored": 0,
        "superseded_pages_ignored": 0,
        "duplicate_pages_ignored": 0,
        "fmr_sheets_created": 0,
        "quarantine_entries": 0,
        "iwp_number": "",
        "workbook": "",
        "production_ready": False,
        "manual_comparison_required": True,
    }


def _scan_pdfs(
    input_dir: Path,
    pdfs: Sequence[Path],
    include_pipe: bool = True,
    pipe_only: bool = False,
    include_spool_numbers: bool = False,
    spool_numbers_only: bool = False,
) -> Tuple[List[str], List[IsoPage], List[QuarantineEntry], Dict[str, int]]:
    iwp_numbers: List[str] = []
    iso_pages: List[IsoPage] = []
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
                native_chars = len(text.strip())
                if is_contextual_attachment_image_run(document, index, page_texts):
                    counts["attachment_images"] += 1
                    continue
                if native_chars < 40:
                    quarantine.append(page_quarantine(
                        pdf, relative, page_number, "ocr_required",
                        "Page has insufficient native text for reliable extraction", text,
                    ))
                    continue
                if is_iso_page(text):
                    iso_pages.append(parse_iso_page(
                        page, page_number, pdf.name, relative,
                        include_pipe=include_pipe,
                        pipe_only=pipe_only,
                        include_spool_numbers=include_spool_numbers,
                        spool_numbers_only=spool_numbers_only,
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
                if is_iso_workflow_status_page(text):
                    counts["other_non_iso"] += 1
                    continue

                normalized = normalize_text(text)
                if "INSTALLATION WORK PACKAGE" in normalized:
                    reason = "Installation Work Package page did not contain a readable IWP Number"
                    code = "iwp_cover_ambiguous"
                elif "ISOMETRIC DRAWING NUMBER" in normalized or "BILL OF MATERIALS" in normalized:
                    reason = "Page contains only part of the required ISO/BOM structure"
                    code = "partial_iso_structure"
                else:
                    reason = "Page did not match the IWP cover, ISO drawing, or an approved attachment"
                    code = "unrecognized_page"
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
    pages: Sequence[IsoPage],
    iwp_number: str,
    include_spool_numbers: bool = False,
) -> Tuple[List[IsoPage], List[QuarantineEntry], int, int, int]:
    quarantine: List[QuarantineEntry] = []
    grouped: Dict[str, List[IsoPage]] = defaultdict(list)
    for iso in pages:
        if not iso.drawing_number or not iso.revision:
            quarantine.append(_quarantine_iso(
                iso, iwp_number, "iso_identity_ambiguous", ";".join(iso.review_reasons)
            ))
            continue
        grouped[iso.drawing_number].append(iso)

    accepted: List[IsoPage] = []
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
            selected = [iso for iso in drawing_pages if int(iso.revision) == highest]
        else:
            selected = list(drawing_pages)
        superseded += len(drawing_pages) - len(selected)

        hashes = {iso.content_hash for iso in selected}
        if len(hashes) > 1:
            for iso in selected:
                quarantine.append(_quarantine_iso(
                    iso, iwp_number, "duplicate_revision_conflict",
                    "Multiple pages have the same drawing revision but different BOM content",
                ))
            continue
        selected.sort(key=lambda iso: iso.order_key)
        chosen = selected[0]
        duplicate += len(selected) - 1

        if chosen.review_reasons:
            quarantine.append(_quarantine_iso(
                chosen, iwp_number, "iso_parse_ambiguous", ";".join(chosen.review_reasons)
            ))
            continue

        for material in chosen.materials:
            material_reasons = material_review_reasons(material)
            if material_reasons:
                quarantine.append(_quarantine_material(
                    chosen, iwp_number, material, material_reasons
                ))

        if include_spool_numbers:
            spool_sets = [set(iso.spool_numbers) for iso in selected]
            common_values = set.intersection(*spool_sets) if spool_sets else set()
            all_values = set.union(*spool_sets) if spool_sets else set()
            chosen.spool_numbers = sorted(common_values, key=spool_sort_key)

            for iso in selected:
                for candidate in iso.spool_candidates:
                    detail = f"{candidate.reason}: {candidate.value}"
                    quarantine.append(_quarantine_iso(
                        iso, iwp_number, "spool_number_candidate", detail
                    ))
                    chosen.spool_review_reasons.append(detail)

            for value in sorted(all_values - common_values, key=spool_sort_key):
                detected = [
                    iso for iso in selected if value in iso.spool_numbers
                ]
                absent = [
                    iso for iso in selected if value not in iso.spool_numbers
                ]
                detected_at = ", ".join(
                    f"{iso.source_path} page {iso.page}" for iso in detected
                )
                absent_at = ", ".join(
                    f"{iso.source_path} page {iso.page}" for iso in absent
                )
                detail = (
                    f"{value} detected in {len(detected)} of {len(selected)} "
                    f"same-revision copies; detected at {detected_at}; "
                    f"absent from {absent_at}"
                )
                quarantine.append(_quarantine_iso(
                    detected[0] if detected else chosen,
                    iwp_number,
                    "spool_number_duplicate_conflict",
                    detail,
                ))
                chosen.spool_review_reasons.append(detail)

            has_candidate = any(iso.spool_candidates for iso in selected)
            if not all_values and not has_candidate:
                detail = "No confident spool number was detected on the selected ISO revision"
                quarantine.append(_quarantine_iso(
                    chosen, iwp_number, "no_spool_number_detected", detail
                ))
                chosen.spool_review_reasons.append(detail)
        accepted.append(chosen)

    accepted.sort(key=lambda iso: iso.order_key)
    return accepted, quarantine, superseded, duplicate, len(grouped)


def run_fmr(
    input_dir: Path,
    output_dir: Path,
    template_path: Optional[Path] = None,
    overwrite: bool = False,
    iwp_number_override: Optional[str] = None,
    destination: Optional[str] = None,
    requested_by: Optional[str] = None,
    deliver_to: Optional[str] = None,
    include_pipe: bool = True,
    pipe_only: bool = False,
    include_spool_numbers: bool = False,
    spool_numbers_only: bool = False,
) -> Dict[str, object]:
    processing_started_at = perf_counter()
    input_dir = input_dir.resolve()
    output_dir = output_dir.resolve()
    template_path = (template_path or DEFAULT_TEMPLATE).resolve()
    selected_modes = sum((pipe_only, include_spool_numbers, spool_numbers_only))
    if selected_modes > 1:
        raise ValueError(
            "--pipe-only, --spool-numbers, and --spool-numbers-only are mutually exclusive"
        )
    if not input_dir.is_dir():
        raise ValueError(f"Input folder does not exist or is not a directory: {input_dir}")
    if input_dir == output_dir:
        raise ValueError("Input and output folders must be different")
    if not template_path.is_file():
        raise ValueError(f"FMR template does not exist: {template_path}")

    pdfs = discover_pdfs(input_dir)
    summary = _base_summary(input_dir, output_dir, template_path, len(pdfs))
    summary["pipe_rows_included"] = (
        (include_pipe and not spool_numbers_only) or pipe_only
    )
    summary["pipe_rows_only"] = pipe_only
    summary["spool_numbers_included"] = (
        include_spool_numbers or spool_numbers_only
    )
    summary["spool_numbers_only"] = spool_numbers_only
    summary["spool_rows_written"] = 0
    summary["spool_review_entries"] = 0
    summary["material_review_entries"] = 0
    iwp_candidates, iso_pages, quarantine, counts = _scan_pdfs(
        input_dir,
        pdfs,
        include_pipe=(include_pipe or include_spool_numbers),
        pipe_only=pipe_only,
        include_spool_numbers=include_spool_numbers,
        spool_numbers_only=spool_numbers_only,
    )
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
            for entry in quarantine:
                if not entry.iwp_number:
                    entry.iwp_number = shown_iwp
            for iso in iso_pages:
                quarantine.append(_quarantine_iso(
                    iso, shown_iwp, "manual_iwp_conflict", detail
                ))
            summary.update({
                "status": "blocked",
                "iwp_number": shown_iwp,
                "quarantine_entries": len(quarantine),
            })
            _write_auxiliary_outputs(
                output_dir, summary, quarantine, iso_pages, processing_started_at
            )
            return summary
        unique_iwps = [override_iwp]
    elif not unique_iwps and overwrite:
        existing_iwp = _iwp_from_existing_output_workbook(output_dir)
        if existing_iwp:
            unique_iwps = [existing_iwp]

    if len(unique_iwps) != 1:
        reason_code = "iwp_missing" if not unique_iwps else "multiple_iwp_numbers"
        detail = (
            "No unambiguous IWP number was found"
            if not unique_iwps
            else f"Conflicting IWP numbers were found: {', '.join(unique_iwps)}"
        )
        shown_iwp = ";".join(unique_iwps)
        for entry in quarantine:
            if not entry.iwp_number:
                entry.iwp_number = shown_iwp
        for iso in iso_pages:
            quarantine.append(_quarantine_iso(iso, shown_iwp, reason_code, detail))
        summary.update({
            "status": "blocked",
            "iwp_number": shown_iwp,
            "quarantine_entries": len(quarantine),
        })
        _write_auxiliary_outputs(
            output_dir, summary, quarantine, iso_pages, processing_started_at
        )
        return summary

    iwp_number = unique_iwps[0]
    summary["iwp_number"] = iwp_number
    for entry in quarantine:
        if not entry.iwp_number:
            entry.iwp_number = iwp_number
    accepted, revision_quarantine, superseded, duplicate, unique_drawings = _select_revisions(
        iso_pages,
        iwp_number,
        include_spool_numbers=(include_spool_numbers or spool_numbers_only),
    )
    quarantine.extend(revision_quarantine)
    summary.update({
        "unique_drawings": unique_drawings,
        "superseded_pages_ignored": superseded,
        "duplicate_pages_ignored": duplicate,
    })

    try:
        names = sheet_names(iwp_number, len(accepted))
        filename = workbook_filename(iwp_number)
    except ValueError as exc:
        for iso in accepted:
            quarantine.append(_quarantine_iso(
                iso, iwp_number, "invalid_sheet_or_filename", str(exc)
            ))
        accepted = []
        names = []
        filename = ""

    workbook_path = output_dir / filename if filename else None
    if workbook_path and accepted:
        build_fmr_workbook(
            template_path,
            workbook_path,
            iwp_number,
            accepted,
            overwrite=overwrite,
            destination=destination,
            requested_by=requested_by,
            deliver_to=deliver_to,
        )
        summary["workbook"] = str(workbook_path)
        summary["fmr_sheets_created"] = len(names)
    else:
        summary["status"] = "complete_no_workbook"

    summary["spool_rows_written"] = sum(
        len(iso.spool_numbers) for iso in accepted
    )
    summary["spool_review_entries"] = sum(
        entry.reason_code in SPOOL_REVIEW_CODES for entry in quarantine
    )
    summary["material_review_entries"] = sum(
        entry.reason_code == MATERIAL_REVIEW_CODE for entry in quarantine
    )
    summary["quarantine_entries"] = len(quarantine)
    _write_auxiliary_outputs(
        output_dir, summary, quarantine, accepted, processing_started_at
    )
    return summary
