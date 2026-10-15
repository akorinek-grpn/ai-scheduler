#!/usr/bin/env bash
# Runs a command with the project's .env loaded, the way start-daemon.sh loads it.
# `npm run daemon` and `npm run daemon:watch` go through this, so a daemon started in a
# terminal gets the same environment as one started in the background. Without it the
# evaluator has no TYPESAFE_API_KEY and every Jev decision falls back to Haiku (2026-10-02).
set -e

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ -f "$PROJECT_ROOT/.env" ]; then
  set -a
  source "$PROJECT_ROOT/.env"
  set +a
fi

exec "$@"
