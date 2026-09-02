import csv
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Sequence

from .analytics_manifest import record_run_manifest
from .categories import DEFAULT_EXTRACTORS, CategoryExtractor
from .model import Record
from .pdf_parser import parse_pdf


FIELDS = list(Record.__dataclass_fields__)
REVIEW_FIELDS = ["review_type"] + FIELDS


def discover_pdfs(folder: Path) -> List[Path]:
    return sorted((p for p in folder.rglob("*") if p.is_file() and p.suffix.lower() == ".pdf"), key=lambda p: str(p).lower())


def _record_id(relative: str, page: int, point: str, category: str, bbox: Sequence[float]) -> str:
    source = f"{relative}|{page}|{point}|{category}|" + ",".join(f"{v:.2f}" for v in bbox)
    return hashlib.sha256(source.encode()).hexdigest()[:20]


def _write_csv(path: Path, fields: List[str], rows: Iterable[Dict[str, object]]) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def run(input_dir: Path, output_dir: Path, threshold: float = 0.85, extractors: Iterable[CategoryExtractor] = DEFAULT_EXTRACTORS) -> Dict[str, object]:
    input_dir = input_dir.resolve()
    output_dir = output_dir.resolve()
    if not input_dir.is_dir():
        raise ValueError(f"Input folder does not exist or is not a directory: {input_dir}")
    if input_dir == output_dir:
        raise ValueError("Input and output folders must be different")
    output_dir.mkdir(parents=True, exist_ok=True)
    pdfs = discover_pdfs(input_dir)
    records: List[Record] = []
    reviews: List[Dict[str, object]] = []
    audits = []
    extractor_list = list(extractors)

    for pdf in pdfs:
        relative = pdf.relative_to(input_dir).as_posix()
        rows, audit = parse_pdf(pdf)
        target_counts = {e.name: 0 for e in extractor_list}
        for row in rows:
            matches = [e.name for e in extractor_list if e.matches(row.description)]
            if len(matches) != 1:
                continue
            category = matches[0]
            target_counts[category] += 1
            reasons = list(row.structural_notes)
            if not row.quantity:
                reasons.append("missing_quantity")
            if not row.commodity_code:
                reasons.append("missing_commodity_code")
            if not row.nominal_size:
                reasons.append("missing_nominal_size")
            confidence = max(0.0, 0.98 - 0.12 * len(set(reasons)))
            status = "accepted" if confidence >= threshold and not reasons else "review"
            page = getattr(row, "_page", 1)
            rec = Record(
                _record_id(relative, page, row.point_number, category, row.bbox), category,
                pdf.name, relative, page, row.point_number, row.description, row.nominal_size,
                row.commodity_code, row.quantity, row.raw_text,
                *[round(v, 2) for v in row.bbox], "native_text", False,
                round(confidence, 3), status, ";".join(sorted(set(reasons)))
            )
            records.append(rec)
            if status == "review":
                reviews.append({"review_type": "material_record", **rec.dict()})

        audit.update({"source_pdf": pdf.name, "source_path": relative, "target_counts": target_counts})
        page_uncertain = any(p.get("status") != "ok" for p in audit.get("pages", [])) or audit.get("status") == "error"
        if sum(target_counts.values()) == 0:
            reason = "pdf_has_neither_bolts_nor_gaskets"
            reviews.append({"review_type": "pdf_no_target_materials", "source_pdf": pdf.name, "source_path": relative, "status": "review", "review_reasons": reason})
            audit["review_reasons"] = [reason]
        elif page_uncertain:
            reason = "one_or_more_pages_structurally_uncertain"
            reviews.append({"review_type": "pdf_structure", "source_pdf": pdf.name, "source_path": relative, "status": "review", "review_reasons": reason})
            audit.setdefault("review_reasons", []).append(reason)
        audits.append(audit)

    by_category = {name: [r for r in records if r.category == name] for name in ("bolt", "gasket")}
    accepted = [r for r in records if r.status == "accepted"]
    _write_csv(output_dir / "bolts_raw.csv", FIELDS, (r.dict() for r in by_category["bolt"]))
    _write_csv(output_dir / "gaskets_raw.csv", FIELDS, (r.dict() for r in by_category["gasket"]))
    _write_csv(output_dir / "bolts_clean.csv", FIELDS, (r.dict() for r in by_category["bolt"] if r.status == "accepted"))
    _write_csv(output_dir / "gaskets_clean.csv", FIELDS, (r.dict() for r in by_category["gasket"] if r.status == "accepted"))
    _write_csv(output_dir / "review_required.csv", REVIEW_FIELDS, reviews)
    _write_csv(output_dir / "combined_takeoff.csv", FIELDS, (r.dict() for r in accepted))
    audit_payload = {"schema_version": "1.0", "generated_at": datetime.now(timezone.utc).isoformat(), "files": audits}
    (output_dir / "pdf_extraction_audit.json").write_text(json.dumps(audit_payload, indent=2), encoding="utf-8")
    summary = {
        "schema_version": "1.0", "generated_at": datetime.now(timezone.utc).isoformat(),
        "status": "review_required" if reviews else "complete",
        "input_folder": str(input_dir), "output_folder": str(output_dir), "pdfs_discovered": len(pdfs),
        "pdfs_with_neither_target": sum(1 for a in audits if sum(a["target_counts"].values()) == 0),
        "bolt_records_raw": len(by_category["bolt"]), "gasket_records_raw": len(by_category["gasket"]),
        "accepted_records": len(accepted), "review_entries": len(reviews), "confidence_threshold": threshold,
        "production_ready": False, "manual_comparison_required": True,
    }
    summary_path = output_dir / "run_summary.json"
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    iso_payload = []
    records_by_source: Dict[str, List[Record]] = {}
    for record in records:
        records_by_source.setdefault(record.source_path, []).append(record)
    for source_path, source_records in records_by_source.items():
        source_pdf = source_records[0].source_pdf
        revision_match = re.search(r"(?:^|[_-])R([A-Za-z0-9]+)(?:\.[^.]+)?$", source_pdf)
        iso_payload.append({
            "drawing_number": Path(source_pdf).stem,
            "revision": revision_match.group(1) if revision_match else "",
            "status": "review" if any(row.status != "accepted" for row in source_records) else "accepted",
            "linear_feet": "",
            "pipe_rows": 0,
            "material_rows": len(source_records),
            "source_pdf": source_pdf,
            "source_path": source_path,
            "page": min(row.page for row in source_records),
        })
    artifact_paths = [
        ("bolt_raw", output_dir / "bolts_raw.csv"),
        ("gasket_raw", output_dir / "gaskets_raw.csv"),
        ("bolt_clean", output_dir / "bolts_clean.csv"),
        ("gasket_clean", output_dir / "gaskets_clean.csv"),
        ("review", output_dir / "review_required.csv"),
        ("combined_takeoff", output_dir / "combined_takeoff.csv"),
        ("extraction_audit", output_dir / "pdf_extraction_audit.json"),
        ("run_summary", summary_path),
    ]
    record_run_manifest(
        output_dir,
        "bolt_gasket",
        summary,
        isos=iso_payload,
        issues=reviews,
        artifacts=artifact_paths,
    )
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    return summary
