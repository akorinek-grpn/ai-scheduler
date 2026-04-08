# AI Scheduler — Design Spec

A local tool for scheduling and monitoring Claude CLI runs across multiple projects. Manages recurring AI tasks via cron, provides a web dashboard for monitoring, and integrates with Claude Code via a skill for conversational job management.

## Architecture

Three components, communicating through the filesystem:

1. **Scheduler Daemon** — standalone Node.js process. Uses `node-cron` for scheduling, watches `scheduler.yaml` for config changes, spawns `claude --headless` for each job, writes run data to `data/`.

2. **Next.js Web UI** — read-heavy dashboard built with shadcn/ui. Reads from `data/` and `scheduler.yaml`. Proxies manual triggers to the daemon. Sidebar navigation, dark zinc theme.

3. **Claude Code Skill** — installed in `~/.claude/skills/`. Manages `scheduler.yaml` conversationally — add, remove, edit, enable/disable jobs. Also provides daemon lifecycle commands (start/stop/status) and opens the UI.

### Data Flow

```
Skill → edits → scheduler.yaml → watched by → Daemon → spawns → claude --headless → writes → data/ → read by → Web UI
```

The daemon exposes a small HTTP API on localhost. The Next.js app proxies to it so the user only interacts with a single port.

## Config File

`scheduler.yaml` at the project root. The daemon watches it with `fs.watch` and hot-reloads on change.

```yaml
version: 1

defaults:
  timeout: 300          # seconds per job
  max_retries: 0
  retain_runs: 50       # runs to keep per job before pruning

jobs:
  review-prs:
    name: "Review Open PRs"
    schedule: "0 9 * * 1-5"
    directory: /Users/akorinek/Programming/groupon-monorepo
    prompt: "Review all open PRs and summarize status"
    enabled: true
    timeout: 600
    tags: [code-review, daily]

  seo-audit:
    name: "Weekly SEO Audit"
    schedule: "0 6 * * 1"
    directory: /Users/akorinek/Programming/next-pwa-app
    prompt: "Run a full SEO audit and write report to docs/seo-report.md"
    enabled: true
    tags: [seo, weekly]
```

### Job Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Human-readable display name |
| `schedule` | yes | Standard cron expression |
| `directory` | yes | Absolute path — working directory for the Claude run |
| `prompt` | yes | The instruction Claude receives |
| `enabled` | no | Default `true`. Quick toggle without removing the job |
| `model` | no | Model override (e.g., `sonnet`, `opus`). Defaults to CLI default |
| `timeout` | no | Seconds. Overrides `defaults.timeout` |
| `max_retries` | no | Overrides `defaults.max_retries` |
| `tags` | no | String array for filtering in the UI |

Config is validated at load time with a Zod schema. Invalid config is rejected with clear error messages; the daemon continues with the last valid config.

## Data Directory

```
data/
├── daemon.json                              # pid, uptime, last heartbeat (every 30s)
└── runs/
    ├── review-prs/
    │   ├── 2026-04-08T09-00-00-abc123/
    │   │   ├── meta.json                    # job config snapshot, trigger type, timestamps
    │   │   ├── output.log                   # streamed stdout/stderr from claude
    │   │   └── status.json                  # { status, exitCode, startedAt, finishedAt }
    │   └── latest -> 2026-04-08T09-00-00-abc123/
    └── seo-audit/
        └── ...
```

- **Run IDs**: `<ISO-timestamp>-<6-char-hash>` — sortable, unique, human-readable
- **`latest` symlink**: per job, points to most recent run
- **`output.log`**: appended in real-time as Claude streams output. This is what the UI tails.
- **`status.json`**: written on start (`running`), updated on completion (`success` / `failed` / `timeout`)
- **`meta.json`**: snapshots job config at run time + trigger type (`scheduled` / `manual`)
- **`daemon.json`**: daemon writes heartbeat every 30 seconds. UI checks this for health.
- **Pruning**: old runs cleaned up per `retain_runs` config

Everything in `data/` is gitignored.

## Daemon API

Express server bound to `127.0.0.1:3501` — no authentication needed. Port stored in `data/daemon.json` so the UI knows where to connect.

```
GET  /api/health                          → { status, pid, uptime, activeJobs }
GET  /api/jobs                            → list all jobs from scheduler.yaml
GET  /api/runs                            → list runs, filterable by ?job=&status=&limit=
GET  /api/runs/:jobId/:runId/log?offset=N → tail log from byte offset N
POST /api/runs/:jobId/trigger             → manually trigger a job, returns run ID
```

### Concurrency

Only one instance of a job runs at a time. If a cron fires while the previous run is still active, the run is skipped and a warning is logged.

### Config Hot-Reload

The daemon watches `scheduler.yaml` with `fs.watch`. On change:
1. Parse and validate new config
2. Diff jobs: added, removed, changed schedule
3. Cancel removed/changed cron entries
4. Register new/changed cron entries
5. Log what changed

If the new config is invalid, log the error and keep the previous config.

## Web UI

Next.js app on `localhost:3500` with shadcn/ui components. Dark theme (zinc palette). Sidebar navigation.

### Pages

**Dashboard** (`/`)
- Stats cards: total jobs, runs today, active runs, next scheduled
- Recent runs table: status badge, job name, directory, trigger type, start time, duration, watch/logs link
- Jobs grid: cards per job with schedule, last run status, "Run now" button, tag filtering

**Jobs** (`/jobs`)
- Full job list with all config details
- Enable/disable toggle per job
- "Run now" button per job
- Filter by tags

**Run History** (`/runs`)
- Filterable table of all runs across all jobs
- Filter by job, status, date range
- Click through to log viewer

**Log Viewer** (`/runs/[jobId]/[runId]`)
- Terminal-style monospace dark panel
- For running jobs: polls `GET /api/runs/:jobId/:runId/log?offset=N` every 3 seconds
- Auto-scroll follows output, "pause" toggle when user scrolls up
- For completed runs: shows full log at once
- Header: job name, run ID, status badge, duration, back button
- Footer: exit code and completion summary

**Config** (`/config`)
- Read-only view of `scheduler.yaml` with syntax highlighting
- Shows last-modified timestamp
- Note directing to the CLI skill for edits

### UI Proxy

Next.js API routes proxy to the daemon API. The browser only talks to the Next.js port. This avoids CORS and gives the user a single URL.

## Claude Code Skill

Installed at `~/.claude/skills/ai-scheduler.md`. Source lives in `skill/` in the project.

### Commands

```
/ai-scheduler add "Job Name" --cron "expr" --dir /path --prompt "instruction"
/ai-scheduler list
/ai-scheduler enable <job-id>
/ai-scheduler disable <job-id>
/ai-scheduler remove <job-id>
/ai-scheduler status         → daemon health + next scheduled runs
/ai-scheduler start          → start the daemon
/ai-scheduler stop           → stop the daemon
/ai-scheduler ui             → open web UI in browser
```

Also works conversationally: "Schedule a daily SEO audit on next-pwa-app every Monday at 6am" — the skill parses intent, reads current config, generates the job entry, writes YAML, confirms.

### Implementation

The skill reads and writes `scheduler.yaml` directly. For daemon commands, it runs shell scripts from `scripts/`. The daemon picks up config changes via file watch.

## Project Structure

```
ai-scheduler/
├── scheduler.yaml
├── package.json
├── tsconfig.json
├── .gitignore
├── src/
│   ├── daemon/
│   │   ├── index.ts            # entry point
│   │   ├── cron-engine.ts      # node-cron management, config watching
│   │   ├── job-runner.ts       # spawns claude --headless, streams to log
│   │   ├── api.ts              # express routes
│   │   └── config.ts           # YAML loading + Zod validation
│   ├── shared/
│   │   ├── types.ts            # Job, Run, Status, DaemonHealth types
│   │   ├── paths.ts            # data directory path helpers
│   │   └── config-schema.ts    # Zod schema for scheduler.yaml
│   └── web/
│       ├── app/
│       │   ├── layout.tsx
│       │   ├── page.tsx
│       │   ├── jobs/page.tsx
│       │   ├── runs/page.tsx
│       │   ├── runs/[jobId]/[runId]/page.tsx
│       │   ├── config/page.tsx
│       │   └── api/
│       │       ├── health/route.ts
│       │       ├── jobs/route.ts
│       │       ├── runs/route.ts
│       │       └── runs/[jobId]/trigger/route.ts
│       ├── components/
│       │   ├── ui/             # shadcn components
│       │   ├── sidebar.tsx
│       │   ├── stats-cards.tsx
│       │   ├── runs-table.tsx
│       │   ├── job-card.tsx
│       │   └── log-viewer.tsx
│       └── lib/
│           └── api-client.ts
├── skill/
│   └── ai-scheduler.md
├── data/                       # gitignored
├── scripts/
│   ├── start-daemon.sh         # starts daemon via tsx, writes PID to data/daemon.json
│   └── stop-daemon.sh          # reads PID from data/daemon.json, sends SIGTERM
└── docs/
    └── superpowers/specs/
```

## Tech Stack

- **Runtime**: Node.js + TypeScript
- **Daemon**: Express, node-cron, js-yaml, zod, child_process (for claude CLI)
- **Web UI**: Next.js 15, React, shadcn/ui, Tailwind CSS
- **Config**: YAML with Zod validation
- **Shared state**: Filesystem (scheduler.yaml + data/ directory)

## Error Handling

- **Claude process crash**: caught by job-runner, status set to `failed`, exit code + stderr captured in log
- **Timeout**: job-runner kills the process after configured timeout, status set to `timeout`
- **Invalid config**: daemon logs error, keeps previous valid config
- **Daemon crash**: `daemon.json` heartbeat goes stale, UI shows "daemon not responding"
- **Disk full / write error**: logged to stderr, run marked as failed

## Testing Strategy

- **Unit tests**: config parsing, path helpers, Zod schemas, cron expression validation
- **Integration tests**: job-runner with a mock claude command, daemon API endpoints
- **Component tests**: React components with mock data (runs-table, job-card, log-viewer)
