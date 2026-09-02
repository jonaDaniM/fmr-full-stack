import argparse
import json
from pathlib import Path

from .fmr_pipeline import run_fmr


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Create Field Material Request worksheets from IWP and ISO PDFs"
    )
    parser.add_argument(
        "--input", required=True, type=Path,
        help="Folder recursively containing one IWP and its ISO PDFs",
    )
    parser.add_argument(
        "--output", required=True, type=Path,
        help="Separate folder for the FMR workbook and review files",
    )
    parser.add_argument(
        "--template", type=Path,
        help="Optional blank FMR .xlsx path (defaults to templates/FMR/blankFMR.xlsx)",
    )
    parser.add_argument(
        "--iwp-number",
        help="Manual IWP number to use when the input folder has no readable cover page",
    )
    parser.add_argument(
        "--destination",
        help="Destination written to every generated FMR (keeps the template value when omitted)",
    )
    parser.add_argument(
        "--requested-by",
        help="Requested By name written to every generated FMR",
    )
    parser.add_argument(
        "--deliver-to",
        help="Deliver To name written to every generated FMR",
    )
    material_group = parser.add_mutually_exclusive_group()
    material_group.add_argument(
        "--pipe", action="store_true",
        help="Deprecated compatibility flag; PIPE rows are now included by default",
    )
    material_group.add_argument(
        "--pipe-only", action="store_true",
        help="Create FMR sheets from only BOM pipe-stock rows whose description starts with PIPE",
    )
    material_group.add_argument(
        "--spool-numbers", action="store_true",
        help="Add extracted ISO spool-number rows before the complete BOM",
    )
    material_group.add_argument(
        "--spool-numbers-only", action="store_true",
        help="Create FMR sheets containing extracted ISO spool-number rows only",
    )
    parser.add_argument(
        "--overwrite", action="store_true",
        help="Allow replacement of an existing generated FMR workbook",
    )
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        summary = run_fmr(
            args.input,
            args.output,
            args.template,
            args.overwrite,
            iwp_number_override=args.iwp_number,
            destination=args.destination,
            requested_by=args.requested_by,
            deliver_to=args.deliver_to,
            include_pipe=True,
            pipe_only=args.pipe_only,
            include_spool_numbers=args.spool_numbers,
            spool_numbers_only=args.spool_numbers_only,
        )
    except (ValueError, FileExistsError) as exc:
        raise SystemExit(str(exc))
    print(json.dumps(summary, indent=2))
    return 2 if summary.get("status") == "blocked" else 0


if __name__ == "__main__":
    raise SystemExit(main())
