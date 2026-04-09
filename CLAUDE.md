# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A local tool for scheduling and monitoring Claude CLI runs across multiple projects. Three components:
1. **Scheduler Daemon** (Node.js, port 3501) — manages cron schedules, spawns jobs, exposes REST API
2. **Web UI** (Next.js, port 3500) — dashboard for viewing jobs, runs, and live logs
3. **Claude Code Skill** (`/ai-scheduler`) — conversational interface for job management

Data flows through the filesystem: `scheduler.yaml` → Daemon → `data/runs/` → Web UI.

## Commands

```bash
npm run daemon           # Start daemon (tsx)
npm run daemon:watch     # Daemon with auto-restart on file changes
npm run dev              # Web UI dev server (port 3500, requires daemon running)
npm run build            # Build web UI for production
npm run test             # Run tests (vitest, single run)
npm run test:watch       # Vitest watch mode

./scripts/start-daemon.sh   # Start daemon in background
./scripts/stop-daemon.sh    # Stop daemon by PID
./scripts/setup.sh          # One-time setup (deps + skill install)
```

## Architecture

### Daemon (`src/daemon/`)

Entry point: `index.ts`. Starts Express on port 3501, loads `scheduler.yaml` via Zod validation, creates `CronEngine`.

- **CronEngine** (`cron-engine.ts`) — manages `node-cron` tasks. `loadJobs()` is idempotent (adds/removes/restarts as needed). Tracks active jobs to prevent overlapping runs. Calls evaluator + pruner after each job completes.
- **JobRunner** (`job-runner.ts`) — spawns either `claude -p --verbose --output-format stream-json` (claude mode) or a shell command (script mode). Parses stream-json events to extract text/tool output. Timeout: SIGTERM → 5s → SIGKILL.
- **Evaluator** (`evaluator.ts`) — non-blocking post-run scoring via Claude haiku. Writes `evaluation.json` with summary, severity (`ok`/`info`/`warning`/`critical`), and follow-up flags.
- **Pruner** (`pruner.ts`) — FIFO cleanup when run count exceeds `retain_runs`.
- **Config** (`config.ts`) — YAML → Zod validation. Returns `{success, data}` or `{success, error}`. Config errors are logged but don't crash; daemon keeps previous valid config.

Hot-reload: daemon watches `scheduler.yaml` with 500ms debounce, no restart needed.

### Web UI (`src/web/`)

Next.js 16 + React 19 + Tailwind CSS v4 + shadcn components. API routes in `src/web/app/api/` proxy to the daemon on port 3501. Polling-based (5s dashboard, 3s logs). Log viewer uses offset-based incremental reads with auto-scroll.

### Shared (`src/shared/`)

- `types.ts` — `RunStatus`, `JobConfig`, `SchedulerConfig`, `RunEvaluation`, etc.
- `config-schema.ts` — Zod schemas. Key constraint: jobs must have `prompt` XOR `command`, not both.
- `paths.ts` — helpers for `data/runs/<job-id>/<run-id>/` paths (meta.json, status.json, output.log, evaluation.json, `latest` symlink).

### TypeScript Config

- Path aliases: `@/*` → `src/web/*`, `@shared/*` → `src/shared/*`
- ESM throughout (`"type": "module"`)
- Strict mode enabled
- Daemon has its own `tsconfig.daemon.json` (inherits root)

### Run Data Structure

```
data/runs/<job-id>/<run-id>/
├── meta.json        # Job config snapshot + trigger type
├── status.json      # {status, exitCode, startedAt, completedAt}
├── output.log       # Parsed stdout
└── evaluation.json  # LLM evaluation (optional)
data/runs/<job-id>/latest -> <run-id>   # Symlink
```

## Testing

Vitest with globals enabled. Tests in `src/daemon/__tests__/` and `src/shared/__tests__/`. Patterns: temp directories for isolation, mock spawn commands, verify exit codes and output files.

## scheduler.yaml Schema

```yaml
version: 1
defaults:
  timeout: 300          # seconds
  max_retries: 0        # schema exists but not implemented
  retain_runs: 50
jobs:
  job-id:
    name: "Human Name"
    schedule: "0 9 * * 1-5"    # cron
    directory: /absolute/path
    type: "claude" | "script"   # default: claude
    prompt: "..."               # claude jobs
    command: "npm test"         # script jobs (mutually exclusive with prompt)
    enabled: true
    model: "sonnet" | "opus" | "haiku"
    timeout: 600
    skip_permissions: false     # --dangerously-skip-permissions
    tags: [daily, health]
```

## Daemon API Endpoints

- `GET /api/health` — status, PID, active jobs
- `GET /api/jobs` — job list with `isActive` flag
- `GET /api/runs?job=&status=&limit=` — filtered run list
- `GET /api/runs/:jobId/:runId/log?offset=` — incremental log content
- `POST /api/runs/:jobId/trigger` — manual job trigger
- `POST /api/reload` — force config reload
