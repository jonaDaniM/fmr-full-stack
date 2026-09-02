#!/usr/bin/env bash
#
# Run the whole thing on this machine.
#
#   ./start-local.sh          start it
#   ./start-local.sh --reset  wipe the database and start fresh
#
# Sign-in is by picking a seeded user; a deployment uses Google instead.

set -euo pipefail
cd "$(dirname "$0")"

DB="${FMR_DB:-fmr}"
export DATABASE_URL="postgres://localhost/${DB}"
export SESSION_SECRET="${SESSION_SECRET:-local-development-only}"
export FMR_DEV_LOGIN=1
export PORT="${PORT:-3000}"

# The drawing reader is Python and lives beside this checkout. If its venv is
# not there the app still runs; only the drawing upload refuses, and says so.
EXTRACT_HOME="${FMR_EXTRACT_HOME:-$(pwd)/packages/extract-iso}"
export FMR_EXTRACT_HOME="$EXTRACT_HOME"
if [[ -x "$EXTRACT_HOME/.venv/bin/python" ]]; then
  export FMR_PYTHON="${FMR_PYTHON:-$EXTRACT_HOME/.venv/bin/python}"
else
  echo "note: no drawing reader at $EXTRACT_HOME/.venv — PDF upload will be unavailable"
  echo "      cd '$EXTRACT_HOME' && python3 -m venv .venv && .venv/bin/pip install -e ."
fi

if ! pg_isready -q 2>/dev/null; then
  echo "PostgreSQL is not running. Start it with:"
  echo "  brew services start postgresql@17"
  exit 1
fi

if [[ "${1:-}" == "--reset" ]]; then
  echo "dropping ${DB}…"
  dropdb --if-exists "$DB"
fi

createdb "$DB" 2>/dev/null && echo "created ${DB}" || true

npm run --silent migrate

if [[ "$(psql -d "$DB" -tAc 'SELECT count(*) FROM users')" == "0" ]]; then
  node db/seed/seed.js
fi

echo
echo "  FMR running at http://localhost:${PORT}"
echo "  Sign in as any seeded user — start with Jonathan D. to see everything."
echo

exec node packages/api/src/server.js
