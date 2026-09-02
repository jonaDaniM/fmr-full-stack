import argparse
import json
from pathlib import Path

from .pipeline import run


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Extract bolt and gasket BOM occurrences from piping-isometric PDFs locally")
    parser.add_argument("--input", required=True, type=Path, help="Folder recursively containing ISO PDFs")
    parser.add_argument("--output", required=True, type=Path, help="Folder for standardized CSV and JSON output")
    parser.add_argument("--confidence-threshold", type=float, default=0.85, help="Acceptance threshold from 0 to 1 (default: 0.85)")
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    if not 0 <= args.confidence_threshold <= 1:
        raise SystemExit("--confidence-threshold must be between 0 and 1")
    try:
        summary = run(args.input, args.output, args.confidence_threshold)
    except ValueError as exc:
        raise SystemExit(str(exc))
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

