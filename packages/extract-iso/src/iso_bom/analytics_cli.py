import argparse
import ipaddress
import json
import threading
import webbrowser
from pathlib import Path

from .analytics_app import create_app


def _loopback_host(value: str) -> str:
    if value.lower() == "localhost":
        return value
    try:
        if ipaddress.ip_address(value).is_loopback:
            return value
    except ValueError:
        pass
    raise argparse.ArgumentTypeError("--host must be localhost or a loopback IP address")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Open the private local analytics dashboard for ISO BOM outputs"
    )
    parser.add_argument(
        "--root", required=True, action="append", type=Path,
        help="Output folder to index; repeat --root to include another folder",
    )
    parser.add_argument(
        "--database", type=Path,
        help="SQLite index path (defaults to <first root>/.analytics/analytics.sqlite3)",
    )
    parser.add_argument("--host", default="127.0.0.1", type=_loopback_host)
    parser.add_argument("--port", default=8765, type=int)
    parser.add_argument("--no-open", action="store_true", help="Do not open the browser automatically")
    parser.add_argument("--reindex", action="store_true", help="Rebuild the SQLite index from source outputs")
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    roots = [root.resolve() for root in args.root]
    missing = [root for root in roots if not root.is_dir()]
    if missing:
        raise SystemExit(f"Output root does not exist: {missing[0]}")
    if not 1 <= args.port <= 65535:
        raise SystemExit("--port must be between 1 and 65535")
    database = (args.database or (roots[0] / ".analytics" / "analytics.sqlite3")).resolve()
    app = create_app(roots, database, reindex=args.reindex)
    result = app.config.get("INITIAL_INDEX_RESULT", {})
    url_host = "[::1]" if args.host == "::1" else args.host
    url = f"http://{url_host}:{args.port}"
    print(json.dumps({"url": url, "database": str(database), **result}, indent=2))
    if not args.no_open:
        threading.Timer(0.75, lambda: webbrowser.open(url)).start()
    app.run(host=args.host, port=args.port, debug=False, use_reloader=False, threaded=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

