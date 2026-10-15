# AGENTS.md

This file provides guidance to coding agents (Claude Code via `CLAUDE.md`, Codex) when working with code in this repository.

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
npm run janitor          # Report leftover dev/MCP processes and reclaimable caches (--apply to act)

./scripts/start-daemon.sh   # Start daemon in background
./scripts/stop-daemon.sh    # Stop daemon by PID
./scripts/setup.sh          # One-time setup (deps + skill install)
```

## Architecture

### Daemon (`src/daemon/`)

Entry point: `index.ts`. Starts Express on port 3501, loads `scheduler.yaml` via Zod validation, creates `CronEngine`.

- **CronEngine** (`cron-engine.ts`) — manages `node-cron` tasks. `loadJobs()` is idempotent (adds/removes/restarts as needed). Tracks active jobs to prevent overlapping runs. Calls evaluator + pruner after each job completes.
- **JobRunner** (`job-runner.ts`) — spawns either `claude -p --verbose --output-format stream-json` (claude mode) or a shell command (script mode). Parses stream-json events to extract text/tool output, and appends a normalized trace (`trace.jsonl`, via `run-trace.ts`) of tool calls, results, subagents and the final outcome. Timeout: SIGTERM → 5s → SIGKILL.
- **Evaluator** (`evaluator.ts`) — non-blocking post-run scoring. Writes `evaluation.json` with summary, severity (`ok`/`info`/`warning`/`critical`), follow-up flags and `source` (`haiku`, `jev`, `jev+haiku`). `evaluator.decision_model` in scheduler.yaml selects the mode: `off` = Claude haiku only; `shadow` = haiku decides, the Jev decision model is asked the same questions and recorded in `evaluation-decision.json`; `enforce` = Jev decides severity/follow-up/failure kind and haiku writes the summary for warning/critical/follow-up runs (falls back to haiku when Jev is unavailable). When Jev's P(follow-up) is inside `SECOND_OPINION_BAND` (0.40–0.60) haiku also gives a second opinion: the evaluation keeps the more severe label and a follow-up asked for by either, and records haiku's verdict as `secondOpinion` (also in the ledger). `benchmark` = Jev decides exactly as in `enforce`, and haiku judges every run in parallel; its verdict is recorded as `haikuBenchmark` (evaluation.json, ledger, and the preserved verdict of pruned runs) and only used inside the second-opinion band. `jev-report.ts` and `cost-stats.ts` count benchmark runs as Haiku-vs-Jev comparisons; enforce-mode Haiku calls are not, since Haiku only runs there when Jev flagged or was unsure.
- **Decision client** (`decision.ts`) — `POST {TYPESAFE_BASE_URL}/v1/systemone` (TypeSafe System One; via OpenRouter with `TYPESAFE_BASE_URL=https://openrouter.ai/api` and model `typesafe/jev-1.13`). Three questions in one request: severity Score, follow-up Noul, failure-kind Choice. The state is the last 200 lines of the log after `dropConnectorNotices()` removes MCP connector status sentences for connectors no job uses (`IDLE_CONNECTOR`: cognee, oncrawl, context7, claude.ai connectors) and the generic "MCP servers need authorization" boilerplate. Reads `TYPESAFE_API_KEY`/`TYPESAFE_BASE_URL`/`TYPESAFE_DEFAULT_MODEL` (the daemon's gitignored `.env` sources `~/.claude/.secrets/typesafe.env`). Reports the provider's `usage.cost` as spend, never a local price table. Never throws; one retry on 429/5xx/529/transport errors.
- **Evaluation ledger** (`evaluation-log.ts`) — after every evaluation, one JSON line in `data/evaluations/YYYY-MM.jsonl` (run facts, duration, execution cost, Haiku verdict and cost, Jev decision with probabilities/latency/cost, agreement). It outlives pruned run directories; `evaluator.log_retain_months` (default 12) drops older month files. `readEvaluationRecords()` reads it back in time order. `jev-report.ts` (`npm run jev:report`) turns it into the enforce-readiness report: compared runs, agreement, confusion matrix, missed criticals, Haiku-only and Jev-only follow-ups (listed for adjudication, not counted as Jev misses), enforce second opinions, latency, savings, READY/NOT READY against `DEFAULT_READINESS`. The cost dashboard derives Jev "estimated savings" and Haiku-agreement counts from retained runs plus the preserved costs and verdicts of pruned runs (`cost-stats.ts` `includeDecision`), using the retained-history average Haiku evaluation cost as the baseline for enforce-mode runs that skipped Haiku.
- **Pruner** (`pruner.ts`) — FIFO cleanup when run count exceeds `retain_runs`.
- **Config** (`config.ts`) — YAML → Zod validation. Returns `{success, data}` or `{success, error}`. Config errors are logged but don't crash; daemon keeps previous valid config.

Hot-reload: daemon watches `scheduler.yaml` with 500ms debounce, no restart needed.

### Web UI (`src/web/`)

Next.js 16 + React 19 + Tailwind CSS v4 + shadcn components. API routes in `src/web/app/api/` proxy to the daemon on port 3501. Polling-based (5s dashboard, 3s logs). Log viewer uses offset-based incremental reads with auto-scroll. The run page switches between **Output** (the log) and **Diagram** (`?view=diagram`), which renders the graph from `GET /api/runs/:jobId/:runId/graph` and polls every 3s while the run is live.

### Janitor (`src/janitor/`, `scripts/janitor.ts`)

Not part of the daemon: a script the `janitor-processes` and `janitor-disk` jobs run (`npm run janitor`, report-only without `--apply`). `processes.ts` is the pure rule set (`planUnits`): a tree is stopped only if it hangs off launchd with no session host in it, is a dev server or MCP server, is unprotected (daemon pid and its tree, this project's paths, launchd services, `janitor.yaml` `protect`), is older than `min_age_minutes`, and was idle between two observations (`data/janitor/state.json`). `collect.ts` reads the machine (ps, lsof, launchctl, top, df, du; macOS), `stop.ts` signals with a pid+start-time identity check, `disk.ts` loads `janitor.yaml` and holds the cache cleaners and directory expiry.

### Shared (`src/shared/`)

- `types.ts` — `RunStatus`, `JobConfig`, `SchedulerConfig`, `RunEvaluation`, etc.
- `config-schema.ts` — Zod schemas. Key constraint: jobs must have `prompt` XOR `command`, not both.
- `paths.ts` — helpers for `data/runs/<job-id>/<run-id>/` paths (meta.json, status.json, output.log, trace.jsonl, evaluation.json, `latest` symlink).
- `run-graph.ts` — pure builder that turns `trace.jsonl` (or, for runs recorded before tracing, `output.log`) into the `RunGraph` behind the Diagram view. Types: `run-trace-types.ts`, `run-graph-types.ts`.

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
├── trace.jsonl      # Normalized tool-call trace (claude jobs, and script runs' inner sessions; drives the Diagram view)
├── session.log      # Script runs only: text of the inner Claude session(s) the script started (inner-sessions.ts)
├── sessions.json    # Script runs only: the inner sessions found (id, cwd, transcript path, counts)
├── evaluation.json  # LLM evaluation (optional)
├── evaluation-cost.json      # Haiku evaluator cost (pending/complete/unavailable)
└── evaluation-decision.json  # Jev answers + usage/spend (shadow or enforce mode only)
data/runs/<job-id>/latest -> <run-id>   # Symlink
data/evaluations/YYYY-MM.jsonl          # Evaluation ledger: one line per evaluated run, kept log_retain_months
```

## Testing

Vitest with globals enabled. Tests in `src/daemon/__tests__/` and `src/shared/__tests__/`. Patterns: temp directories for isolation, mock spawn commands, verify exit codes and output files.

## scheduler.yaml Schema

```yaml
version: 1
defaults:
  timeout: 300          # seconds
  max_retries: 0        # extra attempts on failed/partial runs (timeouts are never retried)
  retain_runs: 50
  priority: background  # background (default): jobs yield CPU/IO to interactive work via
                        # `taskpolicy -c background` (macOS) or `nice -n 19`; normal: no clamp
evaluator:
  decision_model: off   # off | shadow | enforce | benchmark — Jev decision model in the post-run evaluator (see Evaluator)
  log_retain_months: 12 # months of data/evaluations/YYYY-MM.jsonl to keep
hosts:                  # optional: host name (Mac LocalHostName, else os.hostname() minus .local) -> role; declared, every job needs runs_on
  D6H4HDF0Y4: groupon-mac-16
  FL2R12XFMX: { role: groupon-mac-air, ssh: desk }   # ssh: alias the Hosts page (/api/hosts) probes it through
jobs:
  job-id:
    name: "Human Name"
    schedule: "0 9 * * 1-5"    # cron
    directory: /absolute/path
    runs_on: groupon-mac-air   # a role, a list of roles, or all; a daemon loads only its own role's jobs
    type: "claude" | "script"   # default: claude
    prompt: "..."               # claude jobs
    command: "npm test"         # script jobs (mutually exclusive with prompt)
    enabled: true
    model: "sonnet" | "opus" | "haiku"
    timeout: 600
    catchup: "always" | "same-day" | "never"   # missed-slot catch-up runs; default: always
    priority: "background" | "normal"          # per-job override of defaults.priority
    skip_permissions: false     # --dangerously-skip-permissions
    tags: [daily, health]
```

Catch-ups (`catchup.ts`, wired to the engine in `catchup-wiring.ts`): a slot that did not run (sleep, daemon down, overlap, or a node-cron tick dropped for firing 1 s late) gets one catch-up run, found at startup, after a sleep gap, and by a 30 s missed-tick check. A job has at most one catch-up queued at a time, dropped if the job runs anyway (any trigger) before its turn. Before each catch-up the queue waits up to 10 min for the network (`network-gate.ts`: a TCP connect to `api.anthropic.com:443`), then runs it either way. `same-day` skips a catch-up that would start on a later local date than its slot. Jobs get `SCHEDULER_TRIGGER` (`scheduled`/`manual`/`catchup`) and, for catch-ups, `SCHEDULER_CATCHUP_FOR` (the missed slot, ISO).

## Daemon API Endpoints

- `GET /api/health` — status, PID, active jobs
- `GET /api/jobs` — job list with `isActive` flag
- `GET /api/runs?job=&status=&trigger=&scope=&since=&until=&limit=` — filtered run list (`since`/`until`: ISO times, runs that started in that window, else 400; `trigger`: `scheduled` | `manual` | `catchup`; `scope`: `host` (default: this Mac's jobs plus jobs the file no longer names) | `all` (every run on disk, other Macs' history included); any other value is a 400)
- `GET /api/hosts` — every host in `hosts:` with its placed jobs and its daemon's health (this process for the own host, `ssh <alias> curl .../api/health` for the others; see hosts.ts)
- Multi-host data: `?host=<name>|all` on `/api/runs`, `/api/jobs`, `/api/runs/:jobId/:runId` (+ `/log`, `/graph`); default this host. Other hosts' data comes from `data/hosts/<name>/data/`, mirrored by host-sync.ts every 5 min; host-data.ts keeps only records the holder produced (`meta.json`/activity `host`, unstamped = holder), so copies count once. `/api/stats/activity` and `/api/stats/costs` add `hosts[]` beside combined totals. Other hosts are read-only in the UI (`readOnly` on jobs).
- `GET /api/runs/:jobId/:runId/log?offset=&file=` — incremental log content (`file=session`: the run's `session.log`, the inner Claude session text of a script run; run summaries carry `innerSessions`)
- `GET /api/runs/:jobId/:runId/graph` — run diagram data (from `trace.jsonl`, drawn as an agent run; reconstructed from `output.log` for older runs and script runs without an inner session)
- `POST /api/runs/:jobId/trigger` — manual job trigger
- `POST /api/reload` — force config reload
