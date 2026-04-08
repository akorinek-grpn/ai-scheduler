#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
SKILL_SOURCE="$PROJECT_ROOT/skill/ai-scheduler.md"
SKILL_DIR="$HOME/.claude/skills/ai-scheduler"
SKILL_TARGET="$SKILL_DIR/SKILL.md"

echo "AI Scheduler Setup"
echo "=================="
echo ""

# 1. Install dependencies if needed
if [ ! -d "$PROJECT_ROOT/node_modules" ]; then
  echo "Installing dependencies..."
  cd "$PROJECT_ROOT" && npm install
  echo ""
fi

# 2. Create data directory
mkdir -p "$PROJECT_ROOT/data/runs"

# 3. Install skill as symlink (stays in sync with repo)
echo "Installing Claude Code skill..."
mkdir -p "$SKILL_DIR"

# Clean up old formats
rm -f "$HOME/.claude/skills/ai-scheduler.md" 2>/dev/null

if [ -L "$SKILL_TARGET" ] || [ -f "$SKILL_TARGET" ]; then
  rm "$SKILL_TARGET"
fi

cp "$SKILL_SOURCE" "$SKILL_TARGET"
echo "  Installed: $SKILL_TARGET"
echo ""

# 4. Summary
echo "Setup complete!"
echo ""
echo "  Project root:  $PROJECT_ROOT"
echo "  Skill:         $SKILL_TARGET (symlink)"
echo "  Config:        $PROJECT_ROOT/scheduler.yaml"
echo ""
echo "Quick start:"
echo "  $PROJECT_ROOT/scripts/start-daemon.sh   # start scheduler"
echo "  cd $PROJECT_ROOT && npm run dev          # start web UI"
echo "  open http://localhost:3500               # open dashboard"
echo ""
echo "In any Claude Code session, use /ai-scheduler to manage jobs."
