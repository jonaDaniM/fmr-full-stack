import csv
import json
import re
from collections import defaultdict
from datetime import datetime, timezone
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
from .mto_model import (
    MTO_SCOPE_ALL_MATERIALS,
    MTO_SCOPE_COMBINED,
    MTO_SCOPES,
    MtoIsoPage,
)
from .mto_parser import extract_cwa, parse_mto_iso_page
from .mto_workbook import (
    build_consolidated_mto_workbook,
    build_mto_workbook,
    consolidated_tab_row_counts,
    consolidated_workbook_filename,
    validate_mto_template,
    workbook_filename,
)
from .pipeline import discover_pdfs
from .time_savings import processing_seconds, unavailable_estimate


DEFAULT_TEMPLATE = (
    Path(__file__).resolve().parents[2]
    / "templates"
    / "MTO"
    / "Takeoff Spreadsheet Template.xlsx"
)
IWP_FILENAME_RE = re.compile(
    r"\b(?:IP|IWP)-[A-Z0-9]+(?:[-_][A-Z0-9]+){2,}\b",
    re.IGNORECASE,
)


def _raw_excerpt(text: str) -> str:
    return " ".join(text.split())[:1000]


def _quarantine_iso(
    iso: MtoIsoPage,
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


def _write_quarantine(path: Path, entries: Iterable[QuarantineEntry]) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=QUARANTINE_FIELDS)
        writer.writeheader()
        writer.writerows(entry.dict() for entry in entries)


def _write_outputs(
    output_dir: Path,
    summary: Dict[str, object],
    quarantine: Sequence[QuarantineEntry],
    iso_pages: Sequence[MtoIsoPage] = (),
    processing_started_at: Optional[float] = None,
) -> None:
    if processing_started_at is not None:
        summary["processing_seconds"] = processing_seconds(processing_started_at)
    summary.update(unavailable_estimate(
        "workflow_not_measured",
        selected_iso_count=len(iso_pages),
        material_rows=sum(len(iso.materials) for iso in iso_pages),
        overflow_material_rows=0,
    ))
    summary["time_model_version"] = ""
    output_dir.mkdir(parents=True, exist_ok=True)
    quarantine_path = output_dir / "mto_quarantine.csv"
    summary_path = output_dir / "mto_run_summary.json"
    _write_quarantine(quarantine_path, quarantine)
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")

    artifact_paths = [
        ("quarantine", quarantine_path),
        ("run_summary", summary_path),
    ]
    workbook = str(summary.get("workbook") or "")
    if workbook:
        artifact_paths.insert(0, ("mto_workbook", Path(workbook)))

    iso_payload = []
    for iso in iso_pages:
        iso_payload.append({
            "drawing_number": iso.drawing_number,
            "revision": iso.revision,
            "status": "partial" if iso.partial_row_count else "accepted",
            "linear_feet": "",
            "pipe_rows": 0,
            "material_rows": len(iso.materials),
            "partial_rows": iso.partial_row_count,
            "overflow_material_rows": 0,
            "estimated_time_saved_seconds": None,
            "source_pdf": iso.source_pdf,
            "source_path": iso.source_path,
            "page": iso.page,
        })
    record_run_manifest(
        output_dir,
        "mto",
        summary,
        isos=iso_payload,
        issues=quarantine,
        artifacts=artifact_paths,
    )
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")


def _base_summary(
    input_dir: Path,
    output_dir: Path,
    template_path: Path,
    pdf_count: int,
    scope: str,
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
        "selected_iso_drawings": 0,
        "weld_log_pages_ignored": 0,
        "pipe_support_pages_ignored": 0,
        "attachment_image_pages_ignored": 0,
        "fmr_attachment_pages_ignored": 0,
        "logistics_pages_ignored": 0,
        "superseded_pages_ignored": 0,
        "duplicate_pages_ignored": 0,
        "mto_rows_created": 0,
        "mto_rows": 0,
        "partial_rows": 0,
        "mto_scope": scope,
        "quarantine_entries": 0,
        "iwp_number": "",
        "cwa": "",
        "workbook": "",
        "production_ready": False,
        "manual_comparison_required": True,
    }


def _scan_pdfs(
    input_dir: Path,
    pdfs: Sequence[Path],
    scope: str,
) -> Tuple[List[str], List[str], List[MtoIsoPage], List[QuarantineEntry], Dict[str, int]]:
    iwp_numbers: List[str] = []
    cwa_values: List[str] = []
    iso_pages: List[MtoIsoPage] = []
    quarantine: List[QuarantineEntry] = []
    counts = {
        "pages": 0,
        "covers": 0,
        "weld_logs": 0,
        "pipe_supports": 0,
        "attachment_images": 0,
        "fmr_attachments": 0,
        "logistics": 0,
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
                    iso_pages.append(parse_mto_iso_page(
                        page, page_number, pdf.name, relative, scope=scope
                    ))
                    continue
                if is_iwp_cover_page(text):
                    counts["covers"] += 1
                    iwp_number, iwp_reasons = extract_iwp_number(page)
                    cwa, cwa_reasons = extract_cwa(page)
                    if iwp_reasons:
                        quarantine.append(page_quarantine(
                            pdf, relative, page_number, "iwp_cover_ambiguous",
                            ";".join(iwp_reasons), text,
                        ))
                    else:
                        iwp_numbers.append(iwp_number)
                    if cwa_reasons and cwa_reasons != ["cwa_not_detected"]:
                        quarantine.append(page_quarantine(
                            pdf, relative, page_number, "cwa_cover_ambiguous",
                            ";".join(cwa_reasons), text,
                        ))
                    elif cwa:
                        cwa_values.append(cwa)
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
                    code = "unrecognized_page"
                    reason = "Page did not match the IWP cover, ISO drawing, or an approved attachment"
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
    return iwp_numbers, cwa_values, iso_pages, quarantine, counts


def _select_revisions(
    pages: Sequence[MtoIsoPage],
    iwp_number: str,
) -> Tuple[List[MtoIsoPage], List[QuarantineEntry], int, int, int, bool]:
    quarantine: List[QuarantineEntry] = []
    grouped: Dict[str, List[MtoIsoPage]] = defaultdict(list)
    for iso in pages:
        if not iso.drawing_number or not iso.revision:
            quarantine.append(_quarantine_iso(
                iso, iwp_number, "iso_identity_ambiguous", ";".join(iso.review_reasons)
            ))
            continue
        grouped[iso.drawing_number].append(iso)

    accepted: List[MtoIsoPage] = []
    superseded = 0
    duplicate = 0
    blocking_conflict = False
    for drawing_number, drawing_pages in grouped.items():
        revisions = sorted(set(page.revision for page in drawing_pages))
        if len(revisions) > 1 and not all(revision.isdigit() for revision in revisions):
            blocking_conflict = True
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
            blocking_conflict = True
            for iso in selected:
                quarantine.append(_quarantine_iso(
                    iso, iwp_number, "duplicate_revision_conflict",
                    "Multiple pages have the same drawing revision but different BOM content",
                ))
            continue
        selected.sort(key=lambda iso: iso.order_key)
        chosen = selected[0]
        duplicate += len(selected) - 1

        accepted.append(chosen)

    accepted.sort(key=lambda iso: iso.order_key)
    return accepted, quarantine, superseded, duplicate, len(grouped), blocking_conflict


def _resolve_iwp(
    detected: Sequence[str],
    override: Optional[str],
) -> Tuple[str, Optional[QuarantineEntry]]:
    manual = (override or "").strip()
    unique = sorted(set(value for value in detected if value))
    if manual:
        if unique and unique != [manual]:
            shown = ";".join(dict.fromkeys([manual] + unique))
            detail = (
                f"Manual IWP number {manual} conflicts with detected "
                f"IWP numbers: {', '.join(unique)}"
            )
            return shown, _package_quarantine(shown, "manual_iwp_conflict", detail)
        return manual, None
    if len(unique) == 1:
        return unique[0], None
    shown = ";".join(unique)
    reason = "iwp_missing" if not unique else "multiple_iwp_numbers"
    detail = (
        "No unambiguous IWP number was found"
        if not unique
        else f"Conflicting IWP numbers were found: {', '.join(unique)}"
    )
    return shown, _package_quarantine(shown, reason, detail)


def _resolve_cwa(
    detected: Sequence[str],
    override: Optional[str],
    iwp_number: str,
) -> Tuple[str, Optional[QuarantineEntry]]:
    manual = (override or "").strip()
    unique = sorted(set(value for value in detected if value))
    if manual:
        if unique and unique != [manual]:
            shown = ";".join(dict.fromkeys([manual] + unique))
            detail = f"Manual CWA {manual} conflicts with detected CWA values: {', '.join(unique)}"
            return shown, _package_quarantine(iwp_number, "manual_cwa_conflict", detail)
        return manual, None
    if len(unique) == 1:
        return unique[0], None
    shown = ";".join(unique)
    reason = "cwa_missing" if not unique else "multiple_cwa_values"
    detail = (
        "No unambiguous CWA was found; supply --cwa for ISO-only inputs"
        if not unique
        else f"Conflicting CWA values were found: {', '.join(unique)}"
    )
    return shown, _package_quarantine(iwp_number, reason, detail)


def _filename_iwp_number(pdf: Path) -> str:
    match = IWP_FILENAME_RE.search(pdf.stem)
    return match.group(0).replace("_", "-") if match else ""


def _single_character_omission(shorter: str, longer: str) -> bool:
    shorter = shorter.upper()
    longer = longer.upper()
    return len(longer) == len(shorter) + 1 and any(
        longer[:index] + longer[index + 1:] == shorter
        for index in range(len(longer))
    )


def _resolve_batch_pdf_iwp(
    pdf: Path,
    relative: str,
    detected: Sequence[str],
) -> Tuple[str, Optional[QuarantineEntry]]:
    unique = sorted(set(value for value in detected if value))
    filename_iwp = _filename_iwp_number(pdf)
    if len(unique) > 1:
        return "", page_quarantine(
            pdf,
            relative,
            0,
            "multiple_iwp_numbers",
            f"PDF contains conflicting IWP numbers: {', '.join(unique)}",
            pdf.name,
        )
    if not unique:
        if filename_iwp:
            return filename_iwp, None
        return "", page_quarantine(
            pdf,
            relative,
            0,
            "iwp_missing",
            "No IWP number was found on a cover page or in the PDF filename",
            pdf.name,
        )

    cover_iwp = unique[0]
    if not filename_iwp or filename_iwp.upper() == cover_iwp.upper():
        return cover_iwp, None
    if _single_character_omission(cover_iwp, filename_iwp):
        return filename_iwp, page_quarantine(
            pdf,
            relative,
            0,
            "iwp_cover_corrected_from_filename",
            f"Cover text {cover_iwp} appears to omit one character; using filename IWP {filename_iwp}",
            pdf.name,
        )
    return "", page_quarantine(
        pdf,
        relative,
        0,
        "iwp_filename_cover_conflict",
        f"Filename IWP {filename_iwp} conflicts with cover IWP {cover_iwp}",
        pdf.name,
    )


def _merge_counts(target: Dict[str, int], source: Dict[str, int]) -> None:
    for key, value in source.items():
        target[key] = target.get(key, 0) + value


def _group_pdfs_by_iwp(
    input_dir: Path,
    pdfs: Sequence[Path],
    scope: str,
) -> Tuple[
    Dict[str, int],
    List[str],
    List[QuarantineEntry],
    Dict[str, Dict[str, object]],
]:
    total_counts: Dict[str, int] = {}
    all_cwa_values: List[str] = []
    unassigned_quarantine: List[QuarantineEntry] = []
    groups: Dict[str, Dict[str, object]] = {}

    for pdf in pdfs:
        detected_iwps, cwa_values, iso_pages, quarantine, counts = _scan_pdfs(
            input_dir, [pdf], scope
        )
        _merge_counts(total_counts, counts)
        all_cwa_values.extend(cwa_values)
        relative = pdf.relative_to(input_dir).as_posix()
        iwp_number, iwp_issue = _resolve_batch_pdf_iwp(
            pdf, relative, detected_iwps
        )
        if not iwp_number:
            unassigned_quarantine.extend(quarantine)
            if iwp_issue:
                unassigned_quarantine.append(iwp_issue)
            continue

        group = groups.setdefault(iwp_number, {
            "iso_pages": [],
            "quarantine": [],
            "counts": {},
            "source_pdfs": [],
        })
        group["iso_pages"].extend(iso_pages)
        group["quarantine"].extend(quarantine)
        if iwp_issue:
            group["quarantine"].append(iwp_issue)
        _merge_counts(group["counts"], counts)
        group["source_pdfs"].append(relative)

    return total_counts, all_cwa_values, unassigned_quarantine, groups


def _batch_sidecar_dir(output_dir: Path, iwp_number: str, scope: str) -> Path:
    safe_iwp = re.sub(r"[^A-Za-z0-9._()-]+", "_", iwp_number).strip("._")
    return output_dir / "_batch_runs" / safe_iwp / scope


def _run_batch_package(
    input_dir: Path,
    output_dir: Path,
    template_path: Path,
    iwp_number: str,
    cwa: str,
    iso_pages: Sequence[MtoIsoPage],
    quarantine: List[QuarantineEntry],
    counts: Dict[str, int],
    source_pdfs: Sequence[str],
    overwrite: bool,
    scope: str,
) -> Dict[str, object]:
    processing_started_at = perf_counter()
    summary = _base_summary(
        input_dir, output_dir, template_path, len(source_pdfs), scope
    )
    summary.update({
        "batch_mode": "cwa",
        "iwp_number": iwp_number,
        "cwa": cwa,
        "source_pdfs": list(source_pdfs),
        "pages_scanned": counts.get("pages", 0),
        "cover_pages_detected": counts.get("covers", 0),
        "iso_pages_detected": len(iso_pages),
        "weld_log_pages_ignored": counts.get("weld_logs", 0),
        "pipe_support_pages_ignored": counts.get("pipe_supports", 0),
        "attachment_image_pages_ignored": counts.get("attachment_images", 0),
        "fmr_attachment_pages_ignored": counts.get("fmr_attachments", 0),
        "logistics_pages_ignored": counts.get("logistics", 0),
    })
    for entry in quarantine:
        if not entry.iwp_number:
            entry.iwp_number = iwp_number
    sidecar_dir = _batch_sidecar_dir(output_dir, iwp_number, scope)

    if not iso_pages:
        quarantine.append(_package_quarantine(
            iwp_number, "no_iso_pages", "No ISO pages were detected for this IWP"
        ))
        summary.update({"status": "blocked", "quarantine_entries": len(quarantine)})
        _write_outputs(sidecar_dir, summary, quarantine, (), processing_started_at)
        return summary

    (
        accepted,
        revision_quarantine,
        superseded,
        duplicate,
        unique_drawings,
        blocking_revision_conflict,
    ) = _select_revisions(iso_pages, iwp_number)
    quarantine.extend(revision_quarantine)
    summary.update({
        "unique_drawings": unique_drawings,
        "selected_iso_drawings": len(accepted),
        "superseded_pages_ignored": superseded,
        "duplicate_pages_ignored": duplicate,
    })
    if blocking_revision_conflict:
        summary.update({"status": "blocked", "quarantine_entries": len(quarantine)})
        _write_outputs(sidecar_dir, summary, quarantine, accepted, processing_started_at)
        return summary

    try:
        filename = workbook_filename(iwp_number, scope)
    except ValueError as exc:
        quarantine.append(_package_quarantine(iwp_number, "invalid_filename", str(exc)))
        filename = ""

    if not accepted or not filename:
        summary.update({"status": "blocked", "quarantine_entries": len(quarantine)})
        _write_outputs(sidecar_dir, summary, quarantine, accepted, processing_started_at)
        return summary

    workbook_path = output_dir / filename
    try:
        build_mto_workbook(
            template_path,
            workbook_path,
            iwp_number,
            cwa,
            accepted,
            overwrite=overwrite,
            scope=scope,
        )
    except FileExistsError as exc:
        quarantine.append(_package_quarantine(
            iwp_number, "output_exists", str(exc)
        ))
        summary.update({"status": "blocked", "quarantine_entries": len(quarantine)})
        _write_outputs(sidecar_dir, summary, quarantine, accepted, processing_started_at)
        return summary

    rows_created = sum(len(iso.materials) for iso in accepted)
    partial_rows = sum(iso.partial_row_count for iso in accepted)
    summary.update({
        "workbook": str(workbook_path),
        "mto_rows_created": rows_created,
        "mto_rows": rows_created,
        "partial_rows": partial_rows,
        "quarantine_entries": len(quarantine),
    })
    _write_outputs(sidecar_dir, summary, quarantine, accepted, processing_started_at)
    return summary


def _write_batch_outputs(
    output_dir: Path,
    summary: Dict[str, object],
    quarantine: Sequence[QuarantineEntry],
    processing_started_at: float,
) -> None:
    summary["processing_seconds"] = processing_seconds(processing_started_at)
    summary.update(unavailable_estimate(
        "workflow_not_measured",
        selected_iso_count=int(summary.get("selected_iso_drawings") or 0),
        material_rows=int(summary.get("mto_rows") or 0),
        overflow_material_rows=0,
    ))
    summary["time_model_version"] = ""
    output_dir.mkdir(parents=True, exist_ok=True)
    _write_quarantine(output_dir / "mto_batch_quarantine.csv", quarantine)
    (output_dir / "mto_batch_summary.json").write_text(
        json.dumps(summary, indent=2), encoding="utf-8"
    )


def run_mto_batch(
    input_dir: Path,
    output_dir: Path,
    template_path: Optional[Path] = None,
    overwrite: bool = False,
    cwa_override: Optional[str] = None,
    scope: str = MTO_SCOPE_COMBINED,
) -> Dict[str, object]:
    processing_started_at = perf_counter()
    input_dir = input_dir.resolve()
    output_dir = output_dir.resolve()
    template_path = (template_path or DEFAULT_TEMPLATE).resolve()
    if scope not in MTO_SCOPES:
        raise ValueError(f"Unsupported MTO scope: {scope!r}")
    if not input_dir.is_dir():
        raise ValueError(f"Input folder does not exist or is not a directory: {input_dir}")
    if input_dir == output_dir:
        raise ValueError("Input and output folders must be different")
    validate_mto_template(template_path, scope)

    pdfs = discover_pdfs(input_dir)
    (
        total_counts,
        all_cwa_values,
        unassigned_quarantine,
        groups,
    ) = _group_pdfs_by_iwp(input_dir, pdfs, scope)

    cwa, cwa_issue = _resolve_cwa(all_cwa_values, cwa_override, "")
    if cwa_issue:
        unassigned_quarantine.append(cwa_issue)

    summary: Dict[str, object] = {
        "schema_version": "1.0",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "status": "complete",
        "batch_mode": "cwa",
        "input_folder": str(input_dir),
        "output_folder": str(output_dir),
        "template": str(template_path),
        "pdfs_discovered": len(pdfs),
        "pages_scanned": total_counts.get("pages", 0),
        "cover_pages_detected": total_counts.get("covers", 0),
        "iso_pages_detected": sum(
            len(group["iso_pages"]) for group in groups.values()
        ),
        "iwp_packages_detected": len(groups),
        "packages_completed": 0,
        "packages_blocked": 0,
        "selected_iso_drawings": 0,
        "mto_rows_created": 0,
        "mto_rows": 0,
        "partial_rows": 0,
        "mto_scope": scope,
        "cwa": cwa,
        "iwp_numbers": sorted(groups),
        "workbooks": [],
        "package_results": [],
        "quarantine_entries": 0,
        "production_ready": False,
        "manual_comparison_required": True,
    }
    if cwa_issue:
        summary.update({"status": "blocked", "packages_blocked": len(groups)})
        summary["quarantine_entries"] = len(unassigned_quarantine)
        _write_batch_outputs(
            output_dir, summary, unassigned_quarantine, processing_started_at
        )
        return summary

    package_results: List[Dict[str, object]] = []
    all_quarantine = list(unassigned_quarantine)
    for iwp_number in sorted(groups):
        group = groups[iwp_number]
        result = _run_batch_package(
            input_dir,
            output_dir,
            template_path,
            iwp_number,
            cwa,
            group["iso_pages"],
            group["quarantine"],
            group["counts"],
            sorted(group["source_pdfs"]),
            overwrite,
            scope,
        )
        package_results.append(result)
        all_quarantine.extend(group["quarantine"])

    completed = [item for item in package_results if item.get("status") == "complete"]
    blocked = [item for item in package_results if item.get("status") == "blocked"]
    if completed and (blocked or unassigned_quarantine):
        status = "partial"
    elif completed:
        status = "complete"
    else:
        status = "blocked"
    summary.update({
        "status": status,
        "packages_completed": len(completed),
        "packages_blocked": len(blocked) + (1 if unassigned_quarantine else 0),
        "selected_iso_drawings": sum(
            int(item.get("selected_iso_drawings") or 0) for item in package_results
        ),
        "mto_rows_created": sum(
            int(item.get("mto_rows_created") or 0) for item in package_results
        ),
        "mto_rows": sum(int(item.get("mto_rows") or 0) for item in package_results),
        "partial_rows": sum(
            int(item.get("partial_rows") or 0) for item in package_results
        ),
        "workbooks": [str(item["workbook"]) for item in completed],
        "package_results": package_results,
        "quarantine_entries": len(all_quarantine),
    })
    _write_batch_outputs(output_dir, summary, all_quarantine, processing_started_at)
    return summary


def _consolidation_sidecar_stem(scope: str) -> str:
    suffix = {
        "combined": "",
        "bolts-gaskets": "_bolts_gaskets",
        "all-materials": "_all_materials",
    }[scope]
    return f"mto_consolidated{suffix}"


def _write_consolidation_outputs(
    output_dir: Path,
    summary: Dict[str, object],
    quarantine: Sequence[QuarantineEntry],
    packages: Sequence[Tuple[str, Sequence[MtoIsoPage]]],
    processing_started_at: float,
) -> None:
    iso_pages = [iso for _iwp, pages in packages for iso in pages]
    summary["processing_seconds"] = processing_seconds(processing_started_at)
    summary.update(unavailable_estimate(
        "workflow_not_measured",
        selected_iso_count=len(iso_pages),
        material_rows=sum(len(iso.materials) for iso in iso_pages),
        overflow_material_rows=0,
    ))
    summary["time_model_version"] = ""
    output_dir.mkdir(parents=True, exist_ok=True)
    stem = _consolidation_sidecar_stem(str(summary["mto_scope"]))
    quarantine_path = output_dir / f"{stem}_quarantine.csv"
    summary_path = output_dir / f"{stem}_summary.json"
    _write_quarantine(quarantine_path, quarantine)
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")

    artifact_paths = [
        ("quarantine", quarantine_path),
        ("run_summary", summary_path),
    ]
    workbook = str(summary.get("workbook") or "")
    if workbook:
        artifact_paths.insert(0, ("mto_consolidated_workbook", Path(workbook)))

    iso_payload = []
    for iwp_number, pages in packages:
        for iso in pages:
            iso_payload.append({
                "iwp_number": iwp_number,
                "drawing_number": iso.drawing_number,
                "revision": iso.revision,
                "status": "partial" if iso.partial_row_count else "accepted",
                "linear_feet": "",
                "pipe_rows": 0,
                "material_rows": len(iso.materials),
                "partial_rows": iso.partial_row_count,
                "overflow_material_rows": 0,
                "estimated_time_saved_seconds": None,
                "source_pdf": iso.source_pdf,
                "source_path": iso.source_path,
                "page": iso.page,
            })
    record_run_manifest(
        output_dir,
        "mto",
        summary,
        isos=iso_payload,
        issues=quarantine,
        artifacts=artifact_paths,
    )
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")


def run_mto_consolidated(
    input_dir: Path,
    output_dir: Path,
    template_path: Optional[Path] = None,
    overwrite: bool = False,
    cwa_override: Optional[str] = None,
    scope: str = MTO_SCOPE_COMBINED,
) -> Dict[str, object]:
    processing_started_at = perf_counter()
    input_dir = input_dir.resolve()
    output_dir = output_dir.resolve()
    template_path = (template_path or DEFAULT_TEMPLATE).resolve()
    if scope not in MTO_SCOPES:
        raise ValueError(f"Unsupported MTO scope: {scope!r}")
    if not input_dir.is_dir():
        raise ValueError(f"Input folder does not exist or is not a directory: {input_dir}")
    if input_dir == output_dir:
        raise ValueError("Input and output folders must be different")
    validate_mto_template(template_path, scope)

    pdfs = discover_pdfs(input_dir)
    (
        total_counts,
        all_cwa_values,
        unassigned_quarantine,
        groups,
    ) = _group_pdfs_by_iwp(input_dir, pdfs, scope)
    cwa, cwa_issue = _resolve_cwa(all_cwa_values, cwa_override, "")
    if cwa_issue:
        unassigned_quarantine.append(cwa_issue)

    summary: Dict[str, object] = {
        "schema_version": "1.0",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "status": "complete",
        "consolidation_mode": "cwa",
        "input_folder": str(input_dir),
        "output_folder": str(output_dir),
        "template": str(template_path),
        "pdfs_discovered": len(pdfs),
        "pages_scanned": total_counts.get("pages", 0),
        "cover_pages_detected": total_counts.get("covers", 0),
        "iso_pages_detected": sum(
            len(group["iso_pages"]) for group in groups.values()
        ),
        "unique_drawings": 0,
        "selected_iso_drawings": 0,
        "weld_log_pages_ignored": total_counts.get("weld_logs", 0),
        "pipe_support_pages_ignored": total_counts.get("pipe_supports", 0),
        "attachment_image_pages_ignored": total_counts.get("attachment_images", 0),
        "fmr_attachment_pages_ignored": total_counts.get("fmr_attachments", 0),
        "logistics_pages_ignored": total_counts.get("logistics", 0),
        "superseded_pages_ignored": 0,
        "duplicate_pages_ignored": 0,
        "iwp_packages_detected": len(groups),
        "packages_completed": 0,
        "packages_blocked": 0,
        "mto_rows_created": 0,
        "mto_rows": 0,
        "partial_rows": 0,
        "mto_scope": scope,
        "cwa": cwa,
        "iwp_number": f"CWA {cwa} CONSOLIDATED" if cwa else "",
        "iwp_numbers": sorted(groups),
        "iwp_numbers_included": [],
        "iwp_numbers_blocked": [],
        "workbook": "",
        "workbooks": [],
        "package_results": [],
        "quarantine_entries": 0,
        "production_ready": False,
        "manual_comparison_required": True,
    }
    if cwa_issue:
        summary.update({"status": "blocked", "packages_blocked": len(groups)})
        summary["quarantine_entries"] = len(unassigned_quarantine)
        _write_consolidation_outputs(
            output_dir,
            summary,
            unassigned_quarantine,
            (),
            processing_started_at,
        )
        return summary

    included_packages: List[Tuple[str, Sequence[MtoIsoPage]]] = []
    blocked_iwps: List[str] = []
    package_results: List[Dict[str, object]] = []
    all_quarantine = list(unassigned_quarantine)
    total_unique_drawings = 0
    total_superseded = 0
    total_duplicates = 0

    for iwp_number in sorted(groups):
        group = groups[iwp_number]
        iso_pages = group["iso_pages"]
        package_quarantine = group["quarantine"]
        counts = group["counts"]
        for entry in package_quarantine:
            if not entry.iwp_number:
                entry.iwp_number = iwp_number

        result: Dict[str, object] = {
            "status": "complete",
            "iwp_number": iwp_number,
            "cwa": cwa,
            "source_pdfs": sorted(group["source_pdfs"]),
            "pages_scanned": counts.get("pages", 0),
            "cover_pages_detected": counts.get("covers", 0),
            "iso_pages_detected": len(iso_pages),
            "unique_drawings": 0,
            "selected_iso_drawings": 0,
            "included_iso_drawings": 0,
            "mto_rows": 0,
            "partial_rows": 0,
            "quarantine_entries": 0,
            "included_in_consolidated_workbook": False,
        }
        accepted: List[MtoIsoPage] = []
        blocking_revision_conflict = False
        superseded = 0
        duplicate = 0
        unique_drawings = 0

        if not iso_pages:
            package_quarantine.append(_package_quarantine(
                iwp_number,
                "no_iso_pages",
                "No ISO pages were detected for this IWP",
            ))
        else:
            (
                accepted,
                revision_quarantine,
                superseded,
                duplicate,
                unique_drawings,
                blocking_revision_conflict,
            ) = _select_revisions(iso_pages, iwp_number)
            package_quarantine.extend(revision_quarantine)

        total_unique_drawings += unique_drawings
        total_superseded += superseded
        total_duplicates += duplicate
        result.update({
            "unique_drawings": unique_drawings,
            "selected_iso_drawings": len(accepted),
            "superseded_pages_ignored": superseded,
            "duplicate_pages_ignored": duplicate,
        })

        if not accepted or blocking_revision_conflict:
            result["status"] = "blocked"
            blocked_iwps.append(iwp_number)
        else:
            included_packages.append((iwp_number, accepted))
            result.update({
                "included_iso_drawings": len(accepted),
                "mto_rows": sum(len(iso.materials) for iso in accepted),
                "partial_rows": sum(iso.partial_row_count for iso in accepted),
                "included_in_consolidated_workbook": True,
            })

        result["quarantine_entries"] = len(package_quarantine)
        package_results.append(result)
        all_quarantine.extend(package_quarantine)

    completed = [item for item in package_results if item["status"] == "complete"]
    blocked = [item for item in package_results if item["status"] == "blocked"]
    if included_packages:
        filename = consolidated_workbook_filename(cwa, scope)
        workbook_path = output_dir / filename
        build_consolidated_mto_workbook(
            template_path,
            workbook_path,
            cwa,
            included_packages,
            overwrite=overwrite,
            scope=scope,
        )
        workbook = str(workbook_path)
    else:
        workbook = ""

    if completed and (blocked or unassigned_quarantine):
        status = "partial"
    elif completed:
        status = "complete"
    else:
        status = "blocked"
    included_isos = [iso for _iwp, pages in included_packages for iso in pages]
    if scope in (MTO_SCOPE_COMBINED, MTO_SCOPE_ALL_MATERIALS):
        material_rows_by_tab = consolidated_tab_row_counts(cwa, included_packages)
    else:
        material_rows_by_tab = {
            "BOLTS & GASKETS": sum(len(iso.materials) for iso in included_isos)
        }
    summary.update({
        "status": status,
        "unique_drawings": total_unique_drawings,
        "selected_iso_drawings": len(included_isos),
        "superseded_pages_ignored": total_superseded,
        "duplicate_pages_ignored": total_duplicates,
        "packages_completed": len(completed),
        "packages_blocked": len(blocked) + (1 if unassigned_quarantine else 0),
        "mto_rows_created": sum(len(iso.materials) for iso in included_isos),
        "mto_rows": sum(len(iso.materials) for iso in included_isos),
        "material_rows_by_tab": material_rows_by_tab,
        "partial_rows": sum(iso.partial_row_count for iso in included_isos),
        "iwp_numbers_included": [iwp for iwp, _pages in included_packages],
        "iwp_numbers_blocked": blocked_iwps,
        "workbook": workbook,
        "workbooks": [workbook] if workbook else [],
        "package_results": package_results,
        "quarantine_entries": len(all_quarantine),
    })
    _write_consolidation_outputs(
        output_dir,
        summary,
        all_quarantine,
        included_packages,
        processing_started_at,
    )
    return summary


def run_mto(
    input_dir: Path,
    output_dir: Path,
    template_path: Optional[Path] = None,
    overwrite: bool = False,
    iwp_number_override: Optional[str] = None,
    cwa_override: Optional[str] = None,
    scope: str = MTO_SCOPE_COMBINED,
    cwa_batch: bool = False,
    consolidate: bool = False,
) -> Dict[str, object]:
    if cwa_batch and consolidate:
        raise ValueError("--cwa-batch cannot be used with --consolidate")
    if consolidate:
        if iwp_number_override:
            raise ValueError("--iwp-number cannot be used with --consolidate")
        return run_mto_consolidated(
            input_dir,
            output_dir,
            template_path,
            overwrite=overwrite,
            cwa_override=cwa_override,
            scope=scope,
        )
    if cwa_batch:
        if iwp_number_override:
            raise ValueError("--iwp-number cannot be used with --cwa-batch")
        return run_mto_batch(
            input_dir,
            output_dir,
            template_path,
            overwrite=overwrite,
            cwa_override=cwa_override,
            scope=scope,
        )
    processing_started_at = perf_counter()
    input_dir = input_dir.resolve()
    output_dir = output_dir.resolve()
    template_path = (template_path or DEFAULT_TEMPLATE).resolve()
    if scope not in MTO_SCOPES:
        raise ValueError(f"Unsupported MTO scope: {scope!r}")
    if not input_dir.is_dir():
        raise ValueError(f"Input folder does not exist or is not a directory: {input_dir}")
    if input_dir == output_dir:
        raise ValueError("Input and output folders must be different")
    if not template_path.is_file():
        raise ValueError(f"MTO template does not exist: {template_path}")

    pdfs = discover_pdfs(input_dir)
    summary = _base_summary(input_dir, output_dir, template_path, len(pdfs), scope)
    iwp_candidates, cwa_candidates, iso_pages, quarantine, counts = _scan_pdfs(
        input_dir, pdfs, scope
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
    })

    iwp_number, iwp_issue = _resolve_iwp(iwp_candidates, iwp_number_override)
    cwa, cwa_issue = _resolve_cwa(cwa_candidates, cwa_override, iwp_number)
    summary["iwp_number"] = iwp_number
    summary["cwa"] = cwa
    if iwp_issue:
        quarantine.append(iwp_issue)
    if cwa_issue:
        quarantine.append(cwa_issue)
    for entry in quarantine:
        if not entry.iwp_number:
            entry.iwp_number = iwp_number
    if iwp_issue or cwa_issue:
        summary.update({"status": "blocked", "quarantine_entries": len(quarantine)})
        _write_outputs(output_dir, summary, quarantine, iso_pages, processing_started_at)
        return summary

    if not iso_pages:
        quarantine.append(QuarantineEntry(
            source_pdf="", source_path="", page=0, iwp_number=iwp_number,
            reason_code="no_iso_pages", reason_detail="No ISO pages were detected in the package",
        ))
        summary.update({"status": "blocked", "quarantine_entries": len(quarantine)})
        _write_outputs(output_dir, summary, quarantine, iso_pages, processing_started_at)
        return summary

    (
        accepted,
        revision_quarantine,
        superseded,
        duplicate,
        unique_drawings,
        blocking_revision_conflict,
    ) = _select_revisions(iso_pages, iwp_number)
    quarantine.extend(revision_quarantine)
    summary.update({
        "unique_drawings": unique_drawings,
        "selected_iso_drawings": len(accepted),
        "superseded_pages_ignored": superseded,
        "duplicate_pages_ignored": duplicate,
    })
    if blocking_revision_conflict:
        summary.update({"status": "blocked", "quarantine_entries": len(quarantine)})
        _write_outputs(output_dir, summary, quarantine, accepted, processing_started_at)
        return summary

    try:
        filename = workbook_filename(iwp_number, scope)
    except ValueError as exc:
        for iso in accepted:
            quarantine.append(_quarantine_iso(
                iso, iwp_number, "invalid_filename", str(exc)
            ))
        accepted = []
        filename = ""

    if not accepted:
        summary.update({"status": "blocked", "quarantine_entries": len(quarantine)})
        _write_outputs(output_dir, summary, quarantine, accepted, processing_started_at)
        return summary

    workbook_path = output_dir / filename
    build_mto_workbook(
        template_path, workbook_path, iwp_number, cwa, accepted,
        overwrite=overwrite, scope=scope,
    )
    summary["workbook"] = str(workbook_path)
    rows_created = sum(len(iso.materials) for iso in accepted)
    partial_rows = sum(iso.partial_row_count for iso in accepted)
    summary["mto_rows_created"] = rows_created
    summary["mto_rows"] = rows_created
    summary["partial_rows"] = partial_rows
    summary["quarantine_entries"] = len(quarantine)
    _write_outputs(output_dir, summary, quarantine, accepted, processing_started_at)
    return summary
