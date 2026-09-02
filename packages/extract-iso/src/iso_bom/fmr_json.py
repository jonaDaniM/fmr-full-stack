"""Read an IWP package and print what it holds as JSON, for the FMR web app.

The FMR system stages material in a drafts queue where a person checks it
before any crew is sent looking for anything. It needs rows, not a workbook —
so this stops at `_scan_pdfs`, which is where the pages have been read and
classified but nothing has been written to Excel yet. Going through the
workbook and reading the cells back would lose the review reasons and turn
every quantity into a string.

    python -m iso_bom.fmr_json --input ./package [--iwp-number IWP-88-014]

One JSON object on stdout, nothing else. Progress and complaints go to stderr,
because the caller parses stdout and a stray line would break it.

Exit 0 when the package was read, 2 when it holds no drawings at all.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
from contextlib import redirect_stdout
from pathlib import Path
from typing import Dict, List, Optional

# PyMuPDF prints "the `fitz` API is deprecated" to stdout — not stderr — the
# moment it is imported, which lands ahead of the JSON and makes the output
# unparseable. Setting this before the import is the supported way to silence
# it, and it has to happen before anything pulls in the parser.
os.environ.setdefault("PYMUPDF_MESSAGE", "fd:2")

from .fmr_model import material_review_reasons  # noqa: E402
from .fmr_pipeline import _scan_pdfs, discover_pdfs  # noqa: E402


def _material(row) -> Dict[str, object]:
    """One BOM row, named the way the JavaScript side reads it."""
    return {
        "pointNumber": row.point_number,
        "description": row.description,
        "nominalSize": row.nominal_size,
        "commodityCode": row.commodity_code,
        "quantity": row.quantity,
        # Why this row might be wrong, decided here rather than re-derived in
        # JavaScript — the rules for it live with the parser that broke them.
        "reviewReasons": material_review_reasons(row),
    }


def _drawing(page) -> Dict[str, object]:
    return {
        "drawingNumber": page.drawing_number,
        "revision": page.revision,
        "page": page.page,
        "sourcePdf": page.source_pdf,
        "sourcePath": page.source_path,
        "reviewReasons": list(page.review_reasons),
        "spoolNumbers": list(page.spool_numbers),
        "materials": [_material(row) for row in page.materials],
    }


def scan(input_dir: Path, iwp_override: Optional[str] = None) -> Dict[str, object]:
    """Read every PDF under `input_dir` and describe what was found."""
    input_dir = input_dir.resolve()
    if not input_dir.is_dir():
        raise ValueError(f"Input folder does not exist or is not a directory: {input_dir}")

    pdfs = discover_pdfs(input_dir)

    # PyMuPDF prints a deprecation notice about the `fitz` alias to stdout, not
    # stderr. Left alone it lands in the middle of the JSON and the caller
    # cannot parse it, so everything the scan prints is captured and forwarded.
    noise = io.StringIO()
    with redirect_stdout(noise):
        iwp_candidates, iso_pages, quarantine, counts = _scan_pdfs(input_dir, pdfs)
    if noise.getvalue().strip():
        print(noise.getvalue().strip(), file=sys.stderr)

    unique_iwps = sorted({number for number in iwp_candidates if number})
    override = (iwp_override or "").strip()

    # A package normally names itself on its cover page. Bare ISO sheets have
    # no cover, which is why the caller can supply the number instead.
    if override:
        iwp_number = override
        conflict = bool(unique_iwps) and unique_iwps != [override]
    else:
        iwp_number = unique_iwps[0] if len(unique_iwps) == 1 else ""
        conflict = len(unique_iwps) > 1

    return {
        "schemaVersion": "1.0",
        "iwpNumber": iwp_number,
        "iwpCandidates": unique_iwps,
        "iwpConflict": conflict,
        "counts": counts,
        "pdfsDiscovered": len(pdfs),
        "drawings": [_drawing(page) for page in iso_pages],
        "quarantine": [entry.dict() for entry in quarantine],
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Read an IWP package of drawing PDFs and print its material as JSON",
    )
    parser.add_argument(
        "--input", required=True, type=Path,
        help="Folder recursively containing the IWP cover page and its ISO PDFs",
    )
    parser.add_argument(
        "--iwp-number",
        help="IWP number to use when the package has no readable cover page",
    )
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        payload = scan(args.input, args.iwp_number)
    except ValueError as exc:
        raise SystemExit(str(exc))

    json.dump(payload, sys.stdout)
    sys.stdout.write("\n")

    # Nothing to review is not an error, but it is not a success either — the
    # caller says so rather than staging an empty batch.
    return 0 if payload["drawings"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
