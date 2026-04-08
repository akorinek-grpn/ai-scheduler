# AI Scheduler

A local tool for scheduling and monitoring Claude CLI runs across multiple projects. Runs Claude on a cron schedule, captures logs, and provides a web dashboard for monitoring.

## Quick Start

```bash
# Install dependencies + Claude Code skill
./scripts/setup.sh

# Start the scheduler daemon (runs in background)
./scripts/start-daemon.sh

# Start the web UI
npm run dev
```

- **Dashboard:** http://localhost:3500
- **Daemon API:** http://localhost:3501 (internal, proxied through the web UI)

## Stopping

```bash
# Stop the web UI
# Ctrl+C in the terminal running npm run dev

# Stop the daemon
./scripts/stop-daemon.sh
```

## Architecture

Three components:

1. **Scheduler Daemon** — standalone Node.js process that manages cron schedules and spawns `claude -p` for each job
2. **Web UI** — Next.js dashboard for viewing jobs, runs, and logs
3. **Claude Code Skill** — conversational interface for managing jobs (add, remove, enable/disable)

Data flows through the filesystem:
```
scheduler.yaml → Daemon → data/runs/ → Web UI
```

## Managing Jobs

### Using the Claude Code Skill (recommended)

The `/ai-scheduler` skill is installed at `~/.claude/skills/ai-scheduler.md`. Use it conversationally in any Claude Code session:

**Add a job:**
```
/ai-scheduler add "Daily SEO Audit" --cron "0 6 * * 1" --dir ~/Programming/next-pwa-app --prompt "Run a full SEO audit"
```

Or just describe what you want in natural language:
```
> Schedule a daily briefing that runs every weekday at 7am in my personalized-helper project.
>   It should run: bun run briefing
```

The skill will parse your intent, generate the cron expression, and update `scheduler.yaml`.

**List jobs:**
```
/ai-scheduler list
```

**Enable/disable a job:**
```
/ai-scheduler disable market-researcher
/ai-scheduler enable market-researcher
```

**Remove a job:**
```
/ai-scheduler remove old-job
```

**Check daemon status:**
```
/ai-scheduler status
```

**Start/stop daemon:**
```
/ai-scheduler start
/ai-scheduler stop
```

**Open the web UI:**
```
/ai-scheduler ui
```

### Editing scheduler.yaml directly

The config file is at the project root. The daemon watches it and hot-reloads on save.

```yaml
version: 1

defaults:
  timeout: 300        # seconds per job
  max_retries: 0
  retain_runs: 50     # how many runs to keep per job

jobs:
  my-job:
    name: "My Scheduled Job"
    schedule: "0 9 * * 1-5"              # cron expression (weekdays at 9am)
    directory: /absolute/path/to/project  # working directory for claude
    prompt: |                             # what claude should do
      Run the daily health check:
      1. npm test
      2. npm audit
      Report any failures.
    enabled: true
    model: sonnet                         # optional: sonnet, opus, haiku
    timeout: 600                          # optional: override default
    skip_permissions: true                # optional: --dangerously-skip-permissions
    tags: [daily, health]                 # optional: for filtering in the UI
```

### Cron Expression Reference

```
┌───────────── minute (0-59)
│ ┌───────────── hour (0-23)
│ │ ┌───────────── day of month (1-31)
│ │ │ ┌───────────── month (1-12)
│ │ │ │ ┌───────────── day of week (0-7, 0 and 7 are Sunday)
│ │ │ │ │
* * * * *
```

| Expression | Meaning |
|---|---|
| `0 9 * * 1-5` | Weekdays at 9:00 AM |
| `0 6 * * *` | Every day at 6:00 AM |
| `0 7 * * 1` | Every Monday at 7:00 AM |
| `0 9 * * 1,4` | Monday and Thursday at 9:00 AM |
| `0 3 * * 0` | Every Sunday at 3:00 AM |
| `*/30 * * * *` | Every 30 minutes |

## Web UI

The dashboard at http://localhost:3500 shows:

- **Dashboard** — stat cards, recent runs, job overview with manual trigger buttons
- **Jobs** — full job list with tag filtering and "Run now" buttons
- **Run History** — filterable table of all runs across all jobs
- **Log Viewer** — click any run to see its output (live-tailing for active runs)
- **Config** — read-only view of the current `scheduler.yaml`

### Manual Triggers

Click "Run now" on any job card or in the jobs list to trigger an immediate run. The output appears in the runs table and can be watched live.

## Data Directory

All runtime data lives in `data/` (gitignored):

```
data/
├── daemon.json              # daemon health (pid, port, heartbeat)
├── runs/
│   └── <job-id>/
│       ├── <run-id>/
│       │   ├── meta.json    # job config snapshot + trigger type
│       │   ├── output.log   # claude's stdout/stderr
│       │   └── status.json  # running/success/failed/timeout + exit code
│       └── latest -> <run-id>
└── daemon.log               # daemon process stdout
```

Old runs are automatically pruned based on `retain_runs` in the config.

## Installing the Skill

The setup script handles this automatically:

```bash
./scripts/setup.sh
```

This installs the skill to `~/.claude/skills/ai-scheduler.md` with absolute paths to your project root baked in. Re-run it if you move the project directory.

To reinstall manually:
```bash
cp skill/ai-scheduler.md ~/.claude/skills/ai-scheduler.md
```

**Note:** Skills are loaded when a Claude Code session starts. After installing, start a new session to use `/ai-scheduler`.

## Troubleshooting

**Daemon won't start (port in use):**
```bash
lsof -ti:3501 | xargs kill -9
./scripts/start-daemon.sh
```

**Web UI won't start (port in use):**
```bash
lsof -ti:3500 | xargs kill -9
npm run dev
```

**Job runs but claude fails:**
Check the log in `data/runs/<job-id>/latest/output.log`. Common issues:
- Missing API key — ensure `ANTHROPIC_API_KEY` is set in your shell environment
- Directory doesn't exist — check the `directory` path in the job config
- Timeout — increase the `timeout` value for long-running jobs

**Config change not picked up:**
The daemon watches `scheduler.yaml` with a 500ms debounce. Check `data/daemon.log` for reload messages. If the config is invalid, the daemon keeps the previous valid config and logs the error.
