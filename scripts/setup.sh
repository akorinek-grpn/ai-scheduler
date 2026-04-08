#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
SKILL_SOURCE="$PROJECT_ROOT/skill/ai-scheduler.md"
SKILL_TARGET="$HOME/.claude/skills/ai-scheduler.md"

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

# 3. Install skill
echo "Installing Claude Code skill..."
mkdir -p "$HOME/.claude/skills"

# Create a skill that knows its project root
cat > "$SKILL_TARGET" << SKILLEOF
---
name: ai-scheduler
description: Manage AI Scheduler — add, remove, enable/disable scheduled Claude runs, control the daemon, and open the web UI
---

You are managing the AI Scheduler, a tool that runs Claude on a cron schedule across multiple project directories.

**Project root:** \`$PROJECT_ROOT\`
**Config file:** \`$PROJECT_ROOT/scheduler.yaml\`

## Commands

Parse the user's intent and execute one of these actions:

### Add a job
Read \`$PROJECT_ROOT/scheduler.yaml\`, add a new job entry under \`jobs:\`, and write it back. Generate a slug-style job ID from the name (e.g., "Review PRs" → \`review-prs\`).

Required info (ask if not provided):
- **name**: human-readable name
- **schedule**: cron expression (help the user write it if they describe it in natural language like "every weekday at 9am" → \`0 9 * * 1-5\`)
- **directory**: absolute path to the working directory
- **prompt**: the instruction for Claude

Optional: \`model\`, \`timeout\`, \`tags\`, \`enabled\`, \`skip_permissions\`

### List jobs
Read \`$PROJECT_ROOT/scheduler.yaml\` and display all jobs in a readable format.

### Enable / Disable a job
Read \`$PROJECT_ROOT/scheduler.yaml\`, set \`enabled: true\` or \`enabled: false\` on the specified job, write it back.

### Remove a job
Read \`$PROJECT_ROOT/scheduler.yaml\`, remove the job entry, write it back. Confirm with the user before removing.

### Status
Check if the daemon is running by reading \`$PROJECT_ROOT/data/daemon.json\`. Show:
- Daemon status (running/stopped), PID, uptime
- Number of registered jobs
- Currently active runs

### Start daemon
\`\`\`bash
$PROJECT_ROOT/scripts/start-daemon.sh
\`\`\`

### Stop daemon
\`\`\`bash
$PROJECT_ROOT/scripts/stop-daemon.sh
\`\`\`

### Open UI
\`\`\`bash
open http://localhost:3500
\`\`\`

## Rules
- Always read the current \`$PROJECT_ROOT/scheduler.yaml\` before modifying it
- Use \`js-yaml\`-compatible YAML formatting when writing back
- Preserve comments and formatting where possible
- After modifying config, confirm what changed — the daemon picks it up automatically via file watch
SKILLEOF

echo "  Installed to: $SKILL_TARGET"
echo ""

# 4. Summary
echo "Setup complete!"
echo ""
echo "  Project root:  $PROJECT_ROOT"
echo "  Skill:         $SKILL_TARGET"
echo "  Config:        $PROJECT_ROOT/scheduler.yaml"
echo ""
echo "Quick start:"
echo "  $PROJECT_ROOT/scripts/start-daemon.sh   # start scheduler"
echo "  cd $PROJECT_ROOT && npm run dev          # start web UI"
echo "  open http://localhost:3500               # open dashboard"
echo ""
echo "In any Claude Code session, use /ai-scheduler to manage jobs."
