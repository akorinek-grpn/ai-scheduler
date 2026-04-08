#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
DATA_DIR="$PROJECT_ROOT/data"
DAEMON_JSON="$DATA_DIR/daemon.json"

mkdir -p "$DATA_DIR"

# Check if daemon is already running
if [ -f "$DAEMON_JSON" ]; then
  PID=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$DAEMON_JSON','utf8')).pid)" 2>/dev/null || true)
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo "Daemon already running (pid: $PID)"
    exit 0
  fi
  rm -f "$DAEMON_JSON"
fi

echo "Starting AI Scheduler daemon..."
nohup npx tsx "$PROJECT_ROOT/src/daemon/index.ts" >> "$DATA_DIR/daemon.log" 2>&1 &
DAEMON_PID=$!
echo "Daemon started (pid: $DAEMON_PID)"

# Wait for daemon.json to appear
for i in $(seq 1 10); do
  if [ -f "$DAEMON_JSON" ]; then
    echo "Daemon ready on port $(node -e "console.log(JSON.parse(require('fs').readFileSync('$DAEMON_JSON','utf8')).port)")"
    exit 0
  fi
  sleep 0.5
done

echo "Warning: Daemon started but daemon.json not yet written"
