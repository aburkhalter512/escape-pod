#!/usr/bin/env bash
# Manages the local dev Postgres container. Works with either a real
# Docker daemon or Podman (podman machine start) — whichever is actually
# running is used; nothing here assumes Docker Desktop specifically.
set -euo pipefail

CONTAINER_NAME="escape-pod-db"
VOLUME_NAME="escape-pod-db-data"
DB_NAME="draft_pod"
DB_USER="postgres"
DB_PASSWORD="postgres"
DB_PORT="5432"

runtime() {
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    echo docker
  elif command -v podman >/dev/null 2>&1; then
    echo podman
  else
    echo "Error: no working container runtime found (checked docker, podman)." >&2
    echo "Install one, e.g.: brew install podman && podman machine init && podman machine start" >&2
    exit 1
  fi
}

RUNTIME="$(runtime)"

container_exists() {
  [ -n "$("$RUNTIME" ps -aq -f "name=^${CONTAINER_NAME}\$")" ]
}

container_running() {
  [ -n "$("$RUNTIME" ps -q -f "name=^${CONTAINER_NAME}\$")" ]
}

cmd_up() {
  if container_running; then
    echo "$CONTAINER_NAME is already running."
  elif container_exists; then
    echo "Starting existing $CONTAINER_NAME container ($RUNTIME)..."
    "$RUNTIME" start "$CONTAINER_NAME" >/dev/null
  else
    echo "Creating $CONTAINER_NAME container ($RUNTIME)..."
    "$RUNTIME" run -d \
      --name "$CONTAINER_NAME" \
      -e POSTGRES_USER="$DB_USER" \
      -e POSTGRES_PASSWORD="$DB_PASSWORD" \
      -e POSTGRES_DB="$DB_NAME" \
      -p "${DB_PORT}:5432" \
      -v "${VOLUME_NAME}:/var/lib/postgresql/data" \
      postgres:16 >/dev/null
  fi

  printf "Waiting for Postgres to accept connections"
  until "$RUNTIME" exec "$CONTAINER_NAME" pg_isready -U "$DB_USER" >/dev/null 2>&1; do
    printf "."
    sleep 1
  done
  echo " ready."
}

cmd_down() {
  if container_running; then
    "$RUNTIME" stop "$CONTAINER_NAME" >/dev/null
    echo "Stopped $CONTAINER_NAME."
  else
    echo "$CONTAINER_NAME is not running."
  fi
}

cmd_destroy() {
  "$RUNTIME" rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  "$RUNTIME" volume rm "$VOLUME_NAME" >/dev/null 2>&1 || true
  echo "Removed $CONTAINER_NAME and its data volume."
}

case "${1:-up}" in
  up) cmd_up ;;
  down) cmd_down ;;
  destroy) cmd_destroy ;;
  *)
    echo "Usage: $0 [up|down|destroy]" >&2
    exit 1
    ;;
esac
