---
name: ai-scheduler
description: Manage AI Scheduler — add, remove, enable/disable scheduled Claude runs, control the daemon, and open the web UI
user-invocable: true
argument-hint: "<command> [args]"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

You are managing the AI Scheduler, a tool that runs Claude on a cron schedule across multiple project directories.

## Finding the project

Before any operation, locate the project root. Try in order:
1. Check if `scheduler.yaml` exists in the current directory
2. Search upward from the current directory for `scheduler.yaml`
3. Check `~/Programming/ai-scheduler/scheduler.yaml`

Once found, all paths below are relative to that project root.

## Commands

Parse the user's intent and execute one of these actions:

### Add a job
Read `scheduler.yaml`, add a new job entry under `jobs:`, and write it back. Generate a slug-style job ID from the name (e.g., "Review PRs" → `review-prs`).

Required info (ask if not provided):
- **name**: human-readable name
- **schedule**: cron expression (help the user write it if they describe it in natural language like "every weekday at 9am" → `0 9 * * 1-5`)
- **directory**: absolute path to the working directory
- **prompt**: the instruction for Claude

Optional: `model`, `timeout`, `tags`, `enabled`, `skip_permissions`

### List jobs
Read `scheduler.yaml` and display all jobs in a readable format.

### Enable / Disable a job
Read `scheduler.yaml`, set `enabled: true` or `enabled: false` on the specified job, write it back.

### Remove a job
Read `scheduler.yaml`, remove the job entry, write it back. Confirm with the user before removing.

### Status
Check if the daemon is running by reading `data/daemon.json` in the project root. Show:
- Daemon status (running/stopped), PID, uptime
- Number of registered jobs
- Currently active runs

### Start daemon
```bash
<project-root>/scripts/start-daemon.sh
```

### Stop daemon
```bash
<project-root>/scripts/stop-daemon.sh
```

### Open UI
```bash
open http://localhost:3500
```

## Rules
- Always read the current `scheduler.yaml` before modifying it
- Use `js-yaml`-compatible YAML formatting when writing back
- Preserve comments and formatting where possible
- After modifying config, confirm what changed — the daemon picks it up automatically via file watch
