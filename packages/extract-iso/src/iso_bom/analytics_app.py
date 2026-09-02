from pathlib import Path
from typing import Sequence

from flask import Flask, abort, g, jsonify, render_template, request, send_file

from .analytics_store import (
    artifact_record,
    connect_database,
    dashboard_data,
    index_roots,
    package_detail,
)


LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


def _within(path: Path, roots: Sequence[Path]) -> bool:
    resolved = path.resolve()
    for root in roots:
        try:
            resolved.relative_to(root.resolve())
            return True
        except ValueError:
            continue
    return False


def create_app(
    roots: Sequence[Path],
    database_path: Path,
    *,
    reindex: bool = False,
) -> Flask:
    resolved_roots = [root.resolve() for root in roots]
    database_path = database_path.resolve()
    app = Flask(
        __name__,
        template_folder="dashboard_templates",
        static_folder="dashboard_static",
        static_url_path="/assets",
    )
    app.config.update(
        ANALYTICS_ROOTS=resolved_roots,
        ANALYTICS_DATABASE=database_path,
        JSON_SORT_KEYS=False,
    )
    connection = connect_database(database_path)
    try:
        app.config["INITIAL_INDEX_RESULT"] = index_roots(
            connection, resolved_roots, reindex=reindex
        )
    finally:
        connection.close()

    def get_db():
        if "analytics_db" not in g:
            g.analytics_db = connect_database(app.config["ANALYTICS_DATABASE"])
        return g.analytics_db

    @app.teardown_appcontext
    def close_database(_exception=None):
        connection = g.pop("analytics_db", None)
        if connection is not None:
            connection.close()

    @app.before_request
    def enforce_local_host():
        hostname = (request.host.split(":", 1)[0] if not request.host.startswith("[")
                    else request.host.split("]", 1)[0].lstrip("["))
        if hostname.lower() not in LOOPBACK_HOSTS:
            abort(403)

    @app.after_request
    def security_headers(response):
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'"
        )
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        if request.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/")
    def index():
        return render_template(
            "index.html",
            roots=[str(root) for root in resolved_roots],
            database=str(database_path),
        )

    @app.get("/api/dashboard")
    def api_dashboard():
        filters = {
            key: request.args.get(key, "")
            for key in (
                "workflow", "status", "cwa", "mto_scope", "q", "date_from", "date_to"
            )
        }
        return jsonify(dashboard_data(get_db(), filters))

    @app.get("/api/package")
    def api_package():
        package_number = request.args.get("number", "")
        if not package_number:
            abort(400)
        return jsonify(package_detail(get_db(), package_number))

    @app.post("/api/refresh")
    def api_refresh():
        result = index_roots(get_db(), resolved_roots)
        return jsonify(result)

    @app.get("/artifact/<int:artifact_id>")
    def artifact_download(artifact_id: int):
        artifact = artifact_record(get_db(), artifact_id)
        if not artifact:
            abort(404)
        path = Path(str(artifact["path"])).resolve()
        if not _within(path, resolved_roots):
            abort(403)
        if not path.is_file():
            abort(404)
        return send_file(path, as_attachment=True, download_name=path.name)

    @app.get("/api/health")
    def health():
        return jsonify({"status": "ok", "local_only": True})

    return app
