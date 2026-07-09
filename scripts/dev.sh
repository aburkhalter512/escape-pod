#!/usr/bin/env bash
# One command for local dev: brings up the Postgres container, applies
# any pending migrations, then runs the server in watch mode. Ctrl+C
# stops the server; the DB container keeps running (npm run db:down to
# stop it, npm run db:destroy to also drop its data).
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "No .env found — copy .env.example first: cp .env.example .env" >&2
  exit 1
fi

./scripts/db.sh up

echo "Applying migrations..."
npm run prisma:deploy

exec npm run dev:server
