# AI Scheduler — Architecture

## Overview

AI Scheduler is a local job orchestrator that runs Claude Code sessions and shell scripts on cron schedules. It consists of three components: a **daemon** (Express.js on port 3501), a **web UI** (Next.js on port 3500), and a **CLI skill** for conversational management.

```
┌─────────────────────────────────────────────────────────┐
│                     Web UI (:3500)                       │
│  Next.js 16 · React 19 · Tailwind v4 · shadcn/ui        │
│  Dashboard · Timeline · Jobs · Run History · Config      │
│                         │                                │
│                    /api/* proxy                           │
└─────────────────────┬───────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────┐
│                    Daemon (:3501)                         │
│  Express API · node-cron · CronEngine                    │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐              │
│  │ Scheduler │  │   API    │  │ Evaluator │              │
│  │(CronEngine)│  │ (Express)│  │  (Haiku)  │              │
│  └─────┬────┘  └──────────┘  └─────┬─────┘              │
│        │                           │                     │
│        ▼                           │                     │
│  ┌──────────┐                      │                     │
│  │Job Runner│──spawn──▶ claude -p  │                     │
│  │          │──spawn──▶ /bin/sh -c │                     │
│  └─────┬────┘                      │                     │
│        │     writes                │  async eval         │
│        ▼                           ▼                     │
│  data/runs/<jobId>/<runId>/                              │
│    ├── meta.json    (job config, trigger)                │
│    ├── status.json  (running → success|failed|timeout)   │
│    ├── output.log   (parsed stdout)                      │
│    ├── trace.jsonl  (tool-call trace, claude jobs)       │
│    └── eval.json    (AI evaluation, severity, follow-up) │
└─────────────────────────────────────────────────────────┘
                      │
                reads │
                      ▼
              scheduler.yaml
```

## Source Layout

```
src/
├── daemon/                     # Backend daemon process
│   ├── index.ts                # Entry point: startup, heartbeat, config watch, shutdown
│   ├── api.ts                  # REST API: /api/health, /jobs, /runs, /reload, /trigger
│   ├── config.ts               # YAML loader with Zod validation
│   ├── cron-engine.ts          # Job scheduling, overlap prevention, hot-reload
│   ├── catchup.ts              # Missed-slot detection and the catch-up queue
│   ├── catchup-wiring.ts       # Wires queue + startup/wake/30s sweeps to the engine
│   ├── network-gate.ts         # Waits for the network before each catch-up
│   ├── job-runner.ts           # Spawns child processes, parses stream-json output
│   ├── run-trace.ts            # stream-json -> normalized trace.jsonl (Diagram data)
│   ├── run-graph-reader.ts     # Picks trace.jsonl or output.log and builds the run graph
│   ├── evaluator.ts            # Post-run AI evaluation via Claude Haiku
│   └── pruner.ts               # FIFO run retention cleanup
├── shared/                     # Shared between daemon and web
│   ├── types.ts                # TypeScript interfaces (JobConfig, RunStatus, etc.)
│   ├── config-schema.ts        # Zod schema with type-dependent validation
│   ├── paths.ts                # Path helpers for data directory structure
│   ├── run-trace-types.ts      # trace.jsonl event types and capture limits
│   ├── run-graph-types.ts      # RunGraph shape served to the Diagram view
│   └── run-graph.ts            # Pure builders: trace / agent log / script log -> RunGraph
└── web/                        # Next.js frontend
    ├── app/
    │   ├── layout.tsx           # Root layout with Sidebar + NotificationProvider
    │   ├── page.tsx             # Dashboard: stats, AI insights, recent runs, job cards
    │   ├── timeline/page.tsx    # Visual run timeline
    │   ├── jobs/page.tsx        # Job listing with tag filters, enable/disable, trigger
    │   ├── runs/page.tsx        # Run history with job/status filters
    │   ├── runs/[jobId]/[runId]/page.tsx  # Run detail: AI eval, cost, Output | Diagram tabs
    │   ├── config/page.tsx      # Live YAML config editor
    │   └── api/                 # Proxy routes to daemon API
    │       ├── health/route.ts
    │       ├── jobs/route.ts
    │       ├── reload/route.ts
    │       └── runs/route.ts
    ├── components/              # React components
    │   ├── sidebar.tsx          # Navigation + daemon health indicator
    │   ├── stats-cards.tsx      # Dashboard metric cards
    │   ├── ai-insights.tsx      # Evaluation highlights (critical/warning/follow-up)
    │   ├── runs-table.tsx       # Tabular run display with eval column
    │   ├── job-card.tsx         # Job card with run dots, eval summary, toggle
    │   ├── log-viewer.tsx       # Streaming log display with auto-scroll
    │   ├── run-diagram.tsx      # Diagram tab: fetches/polls the run graph
    │   ├── run-diagram/         # Diagram rendering: summary, flow, categories, status marks
    │   ├── run-history-dots.tsx # Compact pass/fail dot indicators
    │   ├── timeline.tsx         # Timeline visualization
    │   └── notification-provider.tsx  # Push notification context
    └── lib/
        ├── api-client.ts        # Typed fetch wrapper for all API endpoints
        ├── run-diagram.ts       # Pure Diagram helpers: grouping, windowing, labels, paths
        ├── format-cron.ts       # Human-readable cron translations
        └── utils.ts             # cn() helper for Tailwind class merging
```

## Job Execution

### Two Job Types

| | Claude (`type: claude`) | Script (`type: script`) |
|---|---|---|
| **Spawns** | `claude -p --verbose --output-format stream-json [--model X] [--dangerously-skip-permissions] <prompt>` | `/bin/sh -c <command>` |
| **Output parsing** | Stream-JSON events → extract text, tool calls, tool results | Raw stdout/stderr piped directly |
| **Use case** | AI reasoning, skill execution, dynamic decisions | Deterministic scripts, pipelines, commands |
| **Required field** | `prompt` | `command` |

### Execution Flow

```
1. CronEngine triggers (scheduled or manual)
2. Overlap check — skip if same job already running
3. Job Runner creates run directory + meta.json + status.json (running)
4. Spawns child process (claude or sh)
5. Streams output to output.log (with stream-json parsing for claude jobs) and, for claude jobs, appends a normalized tool-call trace to trace.jsonl
6. On exit: writes final status.json, stats.json, and a durable data/activity/<job-id>/<run-id>.json record
7. Updates latest symlink
8. Async: Evaluator reads output.log, calls Claude Haiku, writes eval.json
9. Pruner verifies activity preservation before removing oldest runs beyond retain_runs limit
```

Activity totals are derived from the durable per-run ledger, merged by job/run identity with retained provisional runs. The ledger survives log retention, supports idempotent imports and corrections, and retains UTC start-date attribution and per-tool counts. Startup imports available retained history before scheduling jobs; activity API reads reconcile it again. Persistence failures prevent pruning the affected source runs. No previously deleted activity or additional AI-call coverage is inferred.

### Missed Runs (Catch-up)

A slot that did not run gets one catch-up run (`trigger: catchup`, `catchupFor` = the missed slot), queued in `catchup.ts` and run one at a time. Causes include a sleeping machine, a stopped daemon, a still-running previous run, and a node-cron tick dropped for firing 1 s or more late. Detection runs at startup, after a clock gap (sleep), and every 30s for slots of each job's current cron task. The 30s check is needed because node-cron 4 neither replays a dropped tick nor always reports it. A slot counts as run once any run of the job started at or after it, including one still running or left orphaned by a restart (the newest run directory, not the `latest` symlink, which moves only on completion). Only slots node-cron itself fires count: it ANDs day-of-month and day-of-week, where standard cron (and cron-parser) ORs them. Each slot is queued at most once, and a job has at most one catch-up queued at a time (a later missed slot replaces it). A queued catch-up is dropped if the job runs anyway before its turn: any run that started at or after its slot, even one still running. Before starting a catch-up the queue waits for the network (`network-gate.ts`: a TCP connect to `api.anthropic.com:443` every 15 s, for up to 10 min, then it starts anyway) and re-picks its head afterwards, since the entry may have been covered or expired meanwhile. The per-job `catchup` policy applies when a catch-up is queued and again when it starts: `always` (default), `same-day` (skip if it would start on a later local date than the slot), or `never`. Jobs receive `SCHEDULER_TRIGGER` and, for catch-ups, `SCHEDULER_CATCHUP_FOR`.

Known limits: the queue runs catch-ups one at a time and waits while its head entry's job is still active, so a long run's overlap entry delays other jobs' catch-ups.

### Timeout Handling

- Configurable per-job via `timeout` (seconds), falls back to `defaults.timeout`
- SIGTERM sent on timeout, SIGKILL after 5s grace period
- Status set to `"timeout"` (distinct from `"failed"`)

## Configuration

### scheduler.yaml

```yaml
version: 1

defaults:
  timeout: 600        # seconds
  max_retries: 0      # extra attempts on failed/partial runs (timeouts are never retried)
  retain_runs: 30

jobs:
  my-claude-job:
    name: "My AI Task"
    schedule: "0 9 * * 1-5"    # cron expression
    directory: /path/to/project
    type: claude                # default, can be omitted
    prompt: "Do the thing"
    model: sonnet
    skip_permissions: true
    timeout: 300
    catchup: same-day           # always (default) | same-day | never
    enabled: true
    tags: [daily, ai]

  my-script-job:
    name: "My Pipeline"
    schedule: "0 6 * * *"
    directory: /path/to/project
    type: script
    command: "npm run build && npm test"
    timeout: 600
    enabled: true
    tags: [daily, ci]
```

### Schema Validation (Zod)

- `type: "claude"` requires `prompt`, `type: "script"` requires `command`
- Schedule validated as valid cron expression
- Timeout must be positive number
- Tags default to empty array, enabled defaults to true
- `catchup` is optional: `always`, `same-day` or `never` (unset behaves as `always`)

### Hot Reload

Config changes are picked up two ways:
1. `fs.watch` on `scheduler.yaml` with 500ms debounce (unreliable on macOS)
2. `POST /api/reload` — explicit reload via API (reliable, used by the /ai-scheduler skill)

## REST API

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/api/health` | Daemon status, PID, uptime, active jobs |
| `GET` | `/api/jobs` | All jobs with current config and active state |
| `PATCH` | `/api/jobs/:jobId` | Enable/disable a job (modifies scheduler.yaml) |
| `GET` | `/api/runs` | Run history with `?job=`, `?status=`, `?trigger=` (`scheduled`, `manual` or `catchup`; anything else is a 400), `?limit=` filters |
| `GET` | `/api/runs/:jobId/:runId/log` | Incremental log read with `?offset=` for streaming |
| `GET` | `/api/runs/:jobId/:runId/graph` | Run diagram graph: from `trace.jsonl`, or reconstructed from `output.log` for older and script runs |
| `POST` | `/api/runs/:jobId/trigger` | Manually trigger a job |
| `POST` | `/api/reload` | Re-read scheduler.yaml and update cron schedules |

The web UI proxies all API calls through Next.js API routes (`src/web/app/api/*`) which read `data/daemon.json` to discover the daemon port.

## Data Directory

```
data/
├── daemon.json                  # Heartbeat: pid, port, startedAt, lastHeartbeat, activeJobs
├── daemon.log                   # Daemon process stdout/stderr
├── research/                    # AI researcher weekly reports
└── runs/
    └── <jobId>/
        ├── latest → <runId>     # Symlink to most recent run
        └── <runId>/             # e.g., 2026-04-08T15-24-24-7898c4
            ├── meta.json        # { jobId, runId, jobConfig, trigger, startedAt }
            ├── status.json      # { status, exitCode, startedAt, finishedAt }
            ├── output.log       # Parsed output (tool calls + results for claude, raw for scripts)
            ├── trace.jsonl      # One JSON event per line: attempts, tool calls/results, subagents, outcome (claude jobs)
            └── eval.json        # { summary, severity, followUpNeeded, followUpReason, evaluatedAt }
```

## Daemon Lifecycle

### Startup (`scripts/start-daemon.sh`)
1. Check for existing daemon via PID in `daemon.json`
2. Source `.env` if present (for secrets like `GCHAT_WEBHOOK_URL`)
3. Spawn daemon via `nohup npx tsx src/daemon/index.ts`
4. Wait for `daemon.json` to confirm readiness

### Running (`src/daemon/index.ts`)
1. Clean up orphaned runs from previous session (mark stale "running" → "failed")
2. Load and validate `scheduler.yaml`
3. Register cron jobs in CronEngine
4. Start Express API on port 3501
5. Write `daemon.json`, start 30s heartbeat
6. Watch config file for changes

### Shutdown
1. SIGTERM/SIGINT handler stops all cron tasks
2. Clears heartbeat interval
3. Closes Express server
4. Removes `daemon.json`

## Post-Run Evaluation

After each job completes, the evaluator:
1. Reads `output.log` (first 200 + last 200 lines)
2. Calls Claude Haiku with structured output schema
3. Produces: `severity` (ok/info/warning/critical), `summary`, `followUpNeeded`, `followUpReason`
4. Writes `eval.json` alongside the run data
5. Runs async — does not block the next job

The web UI surfaces evaluations in the AI Insights panel, run history table, and job cards.

## CLI Skill (`/ai-scheduler`)

The `/ai-scheduler` Claude Code skill provides conversational management:
- **Add/remove jobs** — modifies `scheduler.yaml` directly
- **Enable/disable** — toggles `enabled` flag
- **List/status** — reads config and `daemon.json`
- **Start/stop daemon** — calls shell scripts
- **Reload** — calls `POST /api/reload` after config changes

## Key Design Decisions

1. **File-based storage** — No database. Runs are directories with JSON files. Simple, inspectable, git-friendly.
2. **Daemon + Web UI separation** — Daemon runs headless (nohup), web UI is optional. Both can restart independently.
3. **Two job types** — Claude for AI tasks, script for deterministic work. Avoids wasting tokens on `npm run build`.
4. **Skill-referenced prompts** — Claude jobs reference skill files (`~/.claude/skills/*/SKILL.md`) rather than inlining logic. The scheduler stays a dumb orchestrator.
5. **Orphan cleanup** — On daemon restart, any runs stuck as "running" are marked "failed". Prevents phantom active jobs.
6. **Async evaluation** — Post-run AI assessment doesn't block scheduling. Evaluations appear in the UI when ready.
