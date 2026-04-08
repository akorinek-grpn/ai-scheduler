#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
DAEMON_JSON="$PROJECT_ROOT/data/daemon.json"

if [ ! -f "$DAEMON_JSON" ]; then
  echo "No daemon.json found — daemon not running"
  exit 0
fi

PID=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$DAEMON_JSON','utf8')).pid)" 2>/dev/null || true)

if [ -z "$PID" ]; then
  echo "Could not read PID from daemon.json"
  rm -f "$DAEMON_JSON"
  exit 1
fi

if kill -0 "$PID" 2>/dev/null; then
  echo "Stopping daemon (pid: $PID)..."
  kill "$PID"
  # Wait for clean shutdown
  for i in $(seq 1 10); do
    if ! kill -0 "$PID" 2>/dev/null; then
      echo "Daemon stopped"
      exit 0
    fi
    sleep 0.5
  done
  echo "Force killing daemon..."
  kill -9 "$PID" 2>/dev/null || true
  rm -f "$DAEMON_JSON"
else
  echo "Daemon not running (stale daemon.json)"
  rm -f "$DAEMON_JSON"
fi
