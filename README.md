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

## Activity History

The Dashboard's Lifetime Activity totals and daily trend use a durable activity ledger in `data/activity/<job-id>/<run-id>.json`, separate from retained run logs. Each small record contains the run identity, start time, AI-session flag, tool-call count, and per-tool counts; it does not copy prompts or logs. Keep this directory in backups.

- Completed runs are recorded automatically, even when the Dashboard is never opened. Retries contribute their combined tool count to one run record, not extra sessions.
- Existing retained runs are imported on daemon startup and reconciled on activity reads. Repeated imports replace the same run record rather than double-counting it. Already-pruned history cannot be recovered.
- Before pruning a run, the daemon must successfully preserve its activity. Running, unreadable, or unpreservable runs are kept for a later attempt. Activity records are atomically replaced and are not subject to `retain_runs`.
- Lifetime totals, daily UTC buckets, and top-tool counts survive log pruning and daemon restarts. In-progress runs remain provisional until completion. Invalid preserved records produce an error rather than silently reporting smaller totals.
- Running-log backfills are not persisted. Native counters are marked finalized and written before terminal status; recovery discards old provisional caches before importing interrupted runs. A valid preserved record takes precedence over log reconstruction when native stats are damaged or missing.
- Coverage is unchanged: sessions mean native Claude job runs, including failed runs; script-internal AI calls and evaluator calls are not included. Historical tool-count limitations are not repaired by this migration. Cost dashboards still cover retained history only.

Restart the daemon after upgrading to activate automatic activity preservation and import the available history.

## Costs and Usage

The Dashboard shows reported USD costs for today, this month, and retained history, plus a 7/30/90-day daily trend and job ranking. Daily and monthly boundaries use **UTC**. Jobs show totals across their retained runs; run details break down execution, retries, script tasks, evaluator overhead, and reported model/token usage.

Model labels accompany costs in recent runs, the run list, job cards, and the selected-period Dashboard overview and ranking. They show exact **reported execution model IDs**, deduplicated across tasks and retry attempts; evaluator models appear separately on run details and never count as execution models. Job totals include models from all retained runs, while Dashboard period labels follow the selected date range. Missing reports display **Models unavailable**. A **Configured model** fallback is not evidence of actual usage: run fallbacks come from that run's saved configuration, not today's job settings.

- Native Claude jobs automatically capture `total_cost_usd` and usage from their structured result. Cumulative results replace prior reports within an attempt, while retry attempts add together. Parent session totals already include native subagents; their results are not added again. Separately launched CLI/API calls inside tools are not automatically attributed.
- The post-run Haiku evaluation is tracked separately, even when its assessment cannot be parsed. An evaluation still running is marked pending.
- These are **reported API-equivalent estimates, not subscription invoices or payment charges**. No hardcoded pricing table is used. External provider charges, subscription fees, and unreported nested work are excluded.
- Missing, corrupt, historical, or uninstrumented usage is **unavailable**, not $0. Partial totals include only known amounts. Dashboard coverage shows how many runs report costs; averages use those tracked runs and can include partial totals. Interrupted attempts without a final cost result remain unavailable.
- Totals cover **retained history**, not lifetime billing: pruning a run also removes its costs. All retained runs contribute, independently of the run list's pagination. An old run's direct URL still loads its cost details.

New runs write `costs.json` alongside `meta.json` and `status.json`. Evaluation costs live in a separate `evaluation-cost.json` so the evaluator and runner do not overwrite each other's data. Cost files are atomically replaced. Existing runs are not assigned guessed prices or modified to backfill dollar amounts.

### Reporting Costs from Script Tasks

Scripts may invoke arbitrary providers, so the scheduler cannot infer their bill from text logs. To report actual provider usage, emit one JSON object per stdout line:

```json
{"type":"scheduler_cost","id":"briefing","label":"Morning briefing","currency":"USD","cost_usd":0.0125,"model":"your-model-id","usage":{"input_tokens":1000,"output_tokens":200,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}
{"type":"scheduler_cost","id":"summary","label":"Daily summary","currency":"USD","cost_usd":0.02}
{"type":"scheduler_cost_complete"}
```

Use the provider's reported cost, not the example amounts. `id`, `currency: "USD"`, and a finite nonnegative numeric `cost_usd` are required; `label` and `usage` are optional. Amounts are **cumulative per task ID within the current attempt**: repeat the same ID to update its total, or use different IDs for independently billed tasks. Do not report a parent total alongside child costs that it already includes.

Scripts can optionally include `model` (a nonblank model ID up to 256 characters) on each task report, even without token counts. Report separate task IDs for separately billed models; the scheduler displays these IDs but does not calculate prices from them. Repeated task reports replace the prior model attribution along with that task's cumulative amount.

Emit `scheduler_cost_complete` after all task reports only when every cost-bearing task in the attempt is covered. Without it, the attempt stays partial. Explicit zero is supported for a verified no-cost task; no output never implies zero. Script stdout remains unchanged in the log. Scripts also receive `SCHEDULER_JOB_ID`, `SCHEDULER_RUN_ID`, and `SCHEDULER_ATTEMPT` for attribution. A script can use this contract for any provider, including Codex or direct API calls; uninstrumented scripts continue running unchanged.

### Cost API

- `GET /api/stats/costs?days=30` — UTC daily buckets, selected-period job ranking, today/month/retained totals and coverage. `days` must be an integer from 1 to 90.
- `GET /api/jobs` — each job includes its retained-history `cost` totals.
- `GET /api/runs` and `GET /api/runs/:jobId/:runId` — include the run's `cost` breakdown; the exact-run endpoint is not subject to pagination.

Restart the daemon after installing this code to enable capture for subsequent runs. Hot-reloading `scheduler.yaml` alone does not load code changes. Let active runs finish before restarting; no paid jobs need to be triggered to enable the feature.

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
  max_retries: 0      # extra attempts on failed/partial runs (timeouts are never retried)
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
├── activity/
│   └── <job-id>/<run-id>.json # durable activity counters, never pruned with logs
├── runs/
│   └── <job-id>/
│       ├── <run-id>/
│       │   ├── meta.json    # job config snapshot + trigger type
│       │   ├── output.log   # claude's stdout/stderr
│       │   └── status.json  # running/success/failed/timeout + exit code
│       └── latest -> <run-id>
└── daemon.log               # daemon process stdout
```

Old runs are automatically pruned based on `retain_runs` in the config, after their activity counters have been preserved in `data/activity/`.

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
