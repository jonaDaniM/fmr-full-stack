import argparse
import json
from pathlib import Path

from .pipe_pipeline import run_pipe_footage


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Create a Word report of pipe linear footage by ISO drawing"
    )
    parser.add_argument(
        "--input", required=True, type=Path,
        help="Folder recursively containing one IWP and its ISO PDFs",
    )
    parser.add_argument(
        "--output", required=True, type=Path,
        help="Separate folder for the Word report and audit files",
    )
    parser.add_argument(
        "--iwp-number",
        help="Manual IWP number to use when the input folder has no readable cover page",
    )
    parser.add_argument(
        "--overwrite", action="store_true",
        help="Allow replacement of an existing pipe-footage report",
    )
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        summary = run_pipe_footage(
            args.input,
            args.output,
            overwrite=args.overwrite,
            iwp_number_override=args.iwp_number,
        )
    except (ValueError, FileExistsError) as exc:
        raise SystemExit(str(exc))
    print(json.dumps(summary, indent=2))
    return 0 if summary.get("status") == "complete" else 2


if __name__ == "__main__":
    raise SystemExit(main())
