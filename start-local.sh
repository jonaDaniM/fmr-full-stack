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
