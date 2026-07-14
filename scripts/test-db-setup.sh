#!/usr/bin/env bash
# Ensures the integration-test database exists and is migrated, inside the
# same escape-pod-db container the regular dev DB already runs in (see
# db.sh) — a second database, not a second container, so this only ever
# needs `npm run db:up` as a prerequisite, nothing extra to stand up.
set -euo pipefail

CONTAINER_NAME="escape-pod-db"
DB_USER="postgres"
TEST_DB_NAME="draft_pod_test"
TEST_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/${TEST_DB_NAME}"

runtime() {
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    echo docker
  elif command -v podman >/dev/null 2>&1; then
    echo podman
  else
    echo "Error: no working container runtime found (checked docker, podman)." >&2
    exit 1
  fi
}

RUNTIME="$(runtime)"

if [ -z "$("$RUNTIME" ps -q -f "name=^${CONTAINER_NAME}\$")" ]; then
  echo "Error: $CONTAINER_NAME isn't running — run 'npm run db:up' first." >&2
  exit 1
fi

exists="$("$RUNTIME" exec "$CONTAINER_NAME" psql -U "$DB_USER" -tAc "SELECT 1 FROM pg_database WHERE datname = '${TEST_DB_NAME}'")"
if [ "$exists" != "1" ]; then
  echo "Creating ${TEST_DB_NAME} database..."
  "$RUNTIME" exec "$CONTAINER_NAME" createdb -U "$DB_USER" "$TEST_DB_NAME"
fi

echo "Applying migrations to ${TEST_DB_NAME}..."
DATABASE_URL="$TEST_DATABASE_URL" npx prisma migrate deploy

echo "Test database ready."
