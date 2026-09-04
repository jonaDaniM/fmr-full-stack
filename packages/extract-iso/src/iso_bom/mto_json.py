"""Read an IWP package and print its Material Takeoff as JSON.

The companion to `fmr_json`. Same scan, same pages, different question: the
FMR side asks the warehouse to fetch material, this asks the material team to
buy it.

    python -m iso_bom.mto_json --input ./package [--cwa 10D] [--iwp-number IWP-1]

One JSON object on stdout. Exit 0 when the package was read, 2 when it holds
no drawings at all.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import List, Optional

os.environ.setdefault("PYMUPDF_MESSAGE", "fd:2")

from .fmr_json import scan  # noqa: E402
from .mto import takeoff  # noqa: E402


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Read an IWP package and print its Material Takeoff as JSON",
    )
    parser.add_argument(
        "--input", required=True, type=Path,
        help="Folder recursively containing the IWP cover page and its ISO PDFs",
    )
    parser.add_argument(
        "--iwp-number",
        help="IWP number to use when the package has no readable cover page",
    )
    parser.add_argument(
        "--cwa",
        help="CWA to use when the cover page does not name exactly one",
    )
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        payload = scan(args.input, args.iwp_number)
    except ValueError as exc:
        raise SystemExit(str(exc))

    result = takeoff(payload, cwa_override=args.cwa)
    json.dump(result, sys.stdout)
    sys.stdout.write("\n")

    return 0 if result["rows"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
