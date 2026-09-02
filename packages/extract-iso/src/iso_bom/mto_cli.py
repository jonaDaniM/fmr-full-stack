import argparse
import json
from pathlib import Path

from .mto_model import MTO_SCOPE_ALL_MATERIALS, MTO_SCOPES
from .mto_pipeline import run_mto


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Create Material Takeoff workbooks from IWP and ISO PDFs"
    )
    parser.add_argument(
        "--input", required=True, type=Path,
        help=(
            "Folder containing one IWP, or multiple IWP packages with "
            "--cwa-batch or --consolidate"
        ),
    )
    parser.add_argument(
        "--output", required=True, type=Path,
        help="Separate folder for the MTO workbook and review files",
    )
    parser.add_argument(
        "--template", type=Path,
        help="Optional blank MTO .xlsx path (defaults to templates/MTO/Takeoff Spreadsheet Template.xlsx)",
    )
    identity = parser.add_mutually_exclusive_group()
    identity.add_argument(
        "--iwp-number",
        help="Manual IWP number to use when the input folder has no readable cover page",
    )
    identity.add_argument(
        "--cwa-batch",
        action="store_true",
        help="Group a CWA folder by IWP and create one MTO workbook per package",
    )
    identity.add_argument(
        "--consolidate",
        action="store_true",
        help="Group a CWA folder by IWP and create one workbook containing all valid packages",
    )
    parser.add_argument(
        "--cwa",
        help="Manual CWA to use when the input folder has no readable work-package CWA",
    )
    material_scope = parser.add_mutually_exclusive_group()
    material_scope.add_argument(
        "--scope", choices=MTO_SCOPES, default="combined",
        help="Material scope to create (default: combined)",
    )
    material_scope.add_argument(
        "--all-materials",
        action="store_true",
        help="Bypass material filters and write every parsed BOM row to COMBINED",
    )
    parser.add_argument(
        "--overwrite", action="store_true",
        help="Allow replacement of an existing generated MTO workbook",
    )
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        summary = run_mto(
            args.input,
            args.output,
            args.template,
            args.overwrite,
            iwp_number_override=args.iwp_number,
            cwa_override=args.cwa,
            scope=(MTO_SCOPE_ALL_MATERIALS if args.all_materials else args.scope),
            cwa_batch=args.cwa_batch,
            consolidate=args.consolidate,
        )
    except (ValueError, FileExistsError) as exc:
        raise SystemExit(str(exc))
    print(json.dumps(summary, indent=2))
    return 2 if summary.get("status") == "blocked" else 0


if __name__ == "__main__":
    raise SystemExit(main())
