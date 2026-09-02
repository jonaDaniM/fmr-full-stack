import json
import os
import tempfile
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Dict, Iterable, Mapping, MutableMapping, Sequence, Tuple


MANIFEST_SCHEMA_VERSION = "1.2"


def _jsonable(value):
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, Mapping):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    return value


def _row_dict(value) -> Dict[str, object]:
    if isinstance(value, Mapping):
        return dict(value)
    if hasattr(value, "dict"):
        return dict(value.dict())
    raise TypeError(f"Analytics row must be a mapping or expose dict(): {type(value)!r}")


def _artifact(kind: str, path: Path) -> Dict[str, object]:
    resolved = path.resolve()
    exists = resolved.is_file()
    stat = resolved.stat() if exists else None
    return {
        "kind": kind,
        "name": resolved.name,
        "path": str(resolved),
        "exists": exists,
        "size": stat.st_size if stat else None,
        "modified_at": (
            datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat()
            if stat else None
        ),
    }


def record_run_manifest(
    output_dir: Path,
    workflow: str,
    summary: MutableMapping[str, object],
    *,
    isos: Sequence[Mapping[str, object]] = (),
    issues: Iterable[object] = (),
    artifacts: Sequence[Tuple[str, Path]] = (),
) -> str:
    """Write one append-only analytics record without failing the main workflow."""
    output_dir = output_dir.resolve()
    run_id = str(uuid.uuid4())
    analytics_dir = output_dir / "analytics_runs"
    generated_at = str(summary.get("generated_at") or datetime.now(timezone.utc).isoformat())
    safe_timestamp = generated_at.replace(":", "").replace("+", "_").replace(".", "-")
    manifest_path = analytics_dir / f"{safe_timestamp}_{run_id}.json"
    summary["analytics_run_id"] = run_id
    summary["analytics_manifest"] = str(manifest_path)
    summary["analytics_status"] = "recorded"

    try:
        analytics_dir.mkdir(parents=True, exist_ok=True)
        payload = {
            "schema_version": MANIFEST_SCHEMA_VERSION,
            "run_id": run_id,
            "workflow": workflow,
            "generated_at": generated_at,
            "status": str(summary.get("status") or "complete"),
            "package_number": str(summary.get("iwp_number") or ""),
            "cwa": str(summary.get("cwa") or ""),
            "mto_scope": str(summary.get("mto_scope") or ""),
            "input_folder": str(summary.get("input_folder") or ""),
            "output_folder": str(summary.get("output_folder") or output_dir),
            "metrics": _jsonable(dict(summary)),
            "isos": _jsonable([dict(item) for item in isos]),
            "issues": _jsonable([_row_dict(item) for item in issues]),
            "artifacts": [_artifact(kind, path) for kind, path in artifacts],
        }
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=analytics_dir, delete=False, suffix=".tmp"
        ) as handle:
            json.dump(payload, handle, indent=2)
            temporary_path = Path(handle.name)
        os.replace(temporary_path, manifest_path)
        return str(manifest_path)
    except Exception as exc:  # analytics must not invalidate a generated report
        summary["analytics_status"] = "warning"
        summary["analytics_warning"] = f"{type(exc).__name__}: {exc}"
        summary["analytics_manifest"] = ""
        return ""
