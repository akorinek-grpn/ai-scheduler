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
npm run jev:report       # Haiku-vs-Jev readiness report from the evaluation ledger
npm run jev:replay       # Replay retained runs with the shipped and an alternative Jev question set (-- --ledger --roots --variant)

./scripts/start-daemon.sh   # Start daemon in background
./scripts/stop-daemon.sh    # Stop daemon by PID
./scripts/setup.sh          # One-time setup (deps + skill install)
```

## Architecture

### Daemon (`src/daemon/`)

Entry point: `index.ts`. Starts Express on port 3501, loads `scheduler.yaml` via Zod validation, creates `CronEngine`.

- **CronEngine** (`cron-engine.ts`) — manages `node-cron` tasks. `loadJobs()` is idempotent (adds/removes/restarts as needed). Tracks active jobs to prevent overlapping runs. Calls evaluator + pruner after each job completes (`afterRun`). A `deferred` result (precondition exit 75) is rated ok by `evaluateDeferredRun` without a model call and the slot is retried through the catch-up queue (`enqueueRetry`: after the job's `retry_after`, default 600 s, at most `DEFERRED_RETRY.maxRetries` = 2 per slot, tracked in `deferredRetries`; manual runs are not retried). `drain()` (POST /api/drain) stops the cron tasks and pauses the queue, refuses new runs, and calls the `onDrained` handler once no run is active; index.ts then exits with `DRAIN_EXIT_CODE` 75 so the LaunchAgent (`KeepAlive SuccessfulExit=false`) starts the new daemon. **Usage hold** (2026-10-16, `usage-limit.ts`, `usage-hold.ts`): a run `blocked` with `usageLimit` (its output carried the account's "You've hit your weekly|session limit · resets ..." line) is rated `warning` by `evaluateUsageLimitedRun` without a model, and the engine holds every job that starts a Claude session (claude-type, or script with `uses_claude: true`) until the reset plus a minute (30 min when the reset text is not understood). A held tick makes no run directory: one log line, `skipped` counted, the slot enqueued under the job's own `catchup` policy, and the queue keeps held entries (`holdUntil` dep) until the hold ends; manual triggers and direct catch-ups of held jobs are refused. The hold lives in `data/usage-hold.json` (reloaded at startup, removed when it expires), shows as `usageHold` on `/api/health` (so the other Mac's Hosts page and the UI banner see it) and is lifted early by `POST /api/usage-hold/clear`. Other scripts (janitors, discovery, reconcile, the headroom gauge) keep running.
- **JobRunner** (`job-runner.ts`) — runs the job's `precondition` first (shell, job directory, job env, `precondition_timeout` default 60 s): exit 0 runs the job, exit 75 (`PRECONDITION_DEFER_EXIT`) finalizes the run as `deferred` with nothing spawned, any other exit or a timeout finalizes it as `failed` with the output. Then spawns either `claude -p --verbose --output-format stream-json` (claude mode) or a shell command (script mode). Parses stream-json events to extract text/tool output, and appends a normalized trace (`trace.jsonl`, via `run-trace.ts`) of tool calls, results, subagents and the final outcome. Timeout: SIGTERM → 5s → SIGKILL. `classifyExit`: 0 success, 2 partial, a code in `outcome_codes.blocked` → `blocked`, a signal exit (no code) → `killed`, else failed; only failed/partial are retried by `max_retries`. A failed/partial attempt whose output tail (last 64 KB of text and stderr) carries the account's usage-limit line (`detectUsageLimit`) becomes `blocked` with `blockedReason: "usage-limit"` and `usageLimit` in status.json, is not retried, and starts the engine's usage hold. Every run (and its precondition) gets `SCHEDULER_DEADLINE`, the ISO instant the attempt is killed at (`deadlineFrom`: the attempt's start plus `timeout`; the precondition sees the run's start plus `timeout`), so a review round can stop starting PRs it cannot finish. For script runs the inner sessions' token usage is priced into `costs.json` (see inner-sessions).
- **Evaluator** (`evaluator.ts`) — non-blocking post-run scoring. Writes `evaluation.json` with summary, severity (`ok`/`info`/`warning`/`critical`), follow-up flags and `source` (`haiku`, `jev`, `jev+haiku`, or `scheduler` for a deferred run rated without any model). `evaluator.decision_model` in scheduler.yaml selects the mode: `off` = Claude haiku only; `shadow` = haiku decides, the Jev decision model is asked the same questions and recorded in `evaluation-decision.json`; `enforce` = Jev decides severity/follow-up/failure kind and haiku (`SUMMARY_MODEL`) writes the summary for warning/critical/follow-up runs (falls back to haiku when Jev is unavailable). When Jev's P(follow-up) is inside `SECOND_OPINION_BAND` (0.55–0.65 around the 0.6 follow-up threshold `FOLLOW_UP_THRESHOLD`; both set 2026-10-15 from `npm run jev:replay`, which replays retained runs through the shipped and an alternative question set) Sonnet (`SECOND_OPINION_MODEL`, since 2026-10-16; one call, it also writes the summary) gives a second opinion: the evaluation keeps the more severe label and a follow-up asked for by either, and records the verdict as `secondOpinion` (also in the ledger, whose `haikuModel` field names the model that actually ran, e.g. `claude-sonnet-5-5`; the `source` value `jev+haiku` is kept for both). `benchmark` = Jev decides exactly as in `enforce`, and haiku judges every run in parallel; its verdict is recorded as `haikuBenchmark` (evaluation.json, ledger, and the preserved verdict of pruned runs) and only used inside the second-opinion band. `jev-report.ts` and `cost-stats.ts` count benchmark runs as Haiku-vs-Jev comparisons; enforce-mode Haiku calls are not, since Haiku only runs there when Jev flagged or was unsure, and deferred runs (no decision, no model) are never comparisons.
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
- `model-prices.ts` — list prices per million tokens for the Claude models (the claude CLI's bundled catalog, read 2026-10-16), used only to cost script runs' inner sessions from their transcripts (`daemon/inner-sessions.ts` tallies usage per model and message id, subagent calls included; `sessionCostEntries` turns it into `costs.json` entries). An unlisted id prices as null, never guessed; `CostEntry.costUsd` is nullable for that case.
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
├── status.json      # {status, exitCode, startedAt, completedAt}; status: running | success | partial | failed | timeout | deferred | blocked | killed
├── output.log       # Parsed stdout
├── trace.jsonl      # Normalized tool-call trace (claude jobs, and script runs' inner sessions; drives the Diagram view)
├── session.log      # Script runs only: text of the inner Claude session(s) the script started (inner-sessions.ts)
├── sessions.json    # Script runs only: the inner sessions found (id, cwd, transcript path, counts, per-model token usage and list-price cost)
├── evaluation.json  # LLM evaluation (optional)
├── evaluation-cost.json      # Haiku evaluator cost (pending/complete/unavailable)
└── evaluation-decision.json  # Jev answers + usage/spend (shadow or enforce mode only)
data/runs/<job-id>/latest -> <run-id>   # Symlink
data/evaluations/YYYY-MM.jsonl          # Evaluation ledger: one line per evaluated run, kept log_retain_months
data/usage-hold.json                    # Present while Claude jobs are held (usage limit); removed when the hold ends
data/usage/latest.json, headroom.jsonl  # The usage-headroom job's samples (report-only)
```

A `blocked` status.json may carry `blockedReason: "usage-limit"` and `usageLimit` (the limit line, its kind and parsed reset); without them, `blocked` means an `outcome_codes.blocked` exit.

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
    precondition: "bash scripts/precondition-autopilot-lock.sh"  # shell, run first: exit 0 run, 75 deferred, else failed
    precondition_timeout: 60    # seconds (default 60)
    retry_after: 600            # seconds before a deferred slot is retried (default 600; 2 retries per slot)
    outcome_codes: { blocked: [30] }  # exit codes recorded as `blocked` (waiting on a person; no retry)
    uses_claude: false          # script jobs: true when the script starts a Claude session (held by the usage hold)
    tags: [daily, health]
```

Keep a job's `timeout` under its schedule interval (the hourly review jobs run 3540, answer-pr-comments 1740): a run killed at exactly the interval is still being torn down (SIGTERM, 5 s grace, SIGKILL) when the next tick fires, which the engine skips as "previous run still active", and `catchup: never` then drops that slot too (babysit-prs 13:00Z and approve-prs 11:40Z on 2026-10-16). autopilot-daily keeps 7200 on purpose: one run is one ticket's implementation and overlapping its next tick is the intended cadence.

Catch-ups (`catchup.ts`, wired to the engine in `catchup-wiring.ts`): a slot that did not run (sleep, daemon down, overlap, or a node-cron tick dropped for firing 1 s late) gets one catch-up run, found at startup, after a sleep gap, and by a 30 s missed-tick check. A job has at most one catch-up queued at a time, dropped if the job runs anyway (any trigger) before its turn. Before each catch-up the queue waits up to 10 min for the network (`network-gate.ts`: a TCP connect to `api.anthropic.com:443`), then runs it either way. `same-day` skips a catch-up that would start on a later local date than its slot. Jobs get `SCHEDULER_TRIGGER` (`scheduled`/`manual`/`catchup`), `SCHEDULER_DEADLINE` (the ISO instant the attempt is killed at) and, for catch-ups, `SCHEDULER_CATCHUP_FOR` (the missed slot, ISO). The same queue carries the retries of deferred slots (`enqueueRetry`, `kind: "retry"`, `notBefore`): they ignore the `catchup` policy, are covered only by a run that starts after the deferred one, run with trigger `catchup` plus `meta.deferredRetry`, and a `pause()` (drain) holds everything. While the usage hold is on, entries of held jobs stay queued (`holdUntil` dep, a timer re-checks at the hold's end) and the others run as usual.

Preconditions live in `scripts/`: `precondition-autopilot-lock.sh` (the review rounds: exit 75 while autopilot-daily's lock is held, via autopilot-daily's `lock-status.sh`) and `precondition-air-load.sh` (the autopilot jobs: the lock, `memory_pressure -Q` free percentage below 20%, kernel memory pressure warn/critical (`kern.memorystatus_vm_pressure_level` ≥ 2), swap in use above 4096 MB, a 5-minute load average above 2.0 × logical cores, CPU throttling below 70% when `pmset -g therm` reports one, or a build/test from another job still running; knobs `AUTOPILOT_MIN_FREE_MEMORY_PCT`, `AUTOPILOT_MAX_SWAP_MB`, `AUTOPILOT_MAX_LOAD_PER_CORE`, `AUTOPILOT_MIN_CPU_SPEED_PCT`; tested with shimmed tools in `precondition-air-load.test.ts`). The load and pressure checks came in on 2026-10-16 (Adam: "if it's busy and there is a risk of crashing, don't run the autopilot") from the Air's own readings that afternoon: 1.8–2.0 load per core on 8 cores during a review round with Chrome open, memory pressure normal, 0.5 GB swap.

`scripts/usage-headroom.py` (the `usage-headroom` job, every 30 min on every host, report-only, 2026-10-16) samples the account's usage window: the Claude Code OAuth token from the login keychain item "Claude Code-credentials" (GUI session only, never printed), one request to `USAGE_ENDPOINT` (default `https://api.anthropic.com/api/oauth/usage`), `data/usage/latest.json` (with the raw body) and one line appended to `data/usage/headroom.jsonl` (bounded to 4000 lines). The response shape is unverified: `parse_usage` takes every top-level object with a utilization figure or a reset time as a window (`five_hour`, `seven_day`, `seven_day_opus`, ...), reads a 0-1 figure as a fraction (`assumed_fraction`), and sets `parsed: false` when nothing known is found; any failure is a sample with `status: unavailable` and exit 0. `--from-file` replays a saved body (the tests). Nothing throttles on these numbers yet.

## Daemon API Endpoints

- `GET /api/health` — status, PID, active jobs, `draining`, `usageHold` (null, or `{kind, until, since, text, skipped, jobId, runId}` while Claude jobs are held)
- `POST /api/drain` — start no new run, answer `{draining, running}`, exit (code 75, launchd restarts) once the running jobs finish; `deploy-air.sh` uses it instead of waiting for idle
- `POST /api/usage-hold/clear` — lift the usage hold before its reset (more usage bought, or the limit text misread); answers `{ok, cleared}`
- `GET /api/usage` — the headroom gauge's newest sample (`latest`, with the raw body), the last 48 ledger lines (`samples`) and the hold, for the dashboard's "Claude usage window" card
- `GET /api/jobs` — job list with `isActive` flag
- `GET /api/runs?job=&status=&trigger=&scope=&since=&until=&limit=` — filtered run list (`since`/`until`: ISO times, runs that started in that window, else 400; `trigger`: `scheduled` | `manual` | `catchup`; `scope`: `host` (default: this Mac's jobs plus jobs the file no longer names) | `all` (every run on disk, other Macs' history included); any other value is a 400)
- `GET /api/hosts` — every host in `hosts:` with its placed jobs and its daemon's health (this process for the own host, `ssh <alias> curl .../api/health` for the others; see hosts.ts)
- Multi-host data: `?host=<name>|all` on `/api/runs`, `/api/jobs`, `/api/runs/:jobId/:runId` (+ `/log`, `/graph`); default this host. Other hosts' data comes from `data/hosts/<name>/data/`, mirrored by host-sync.ts every 5 min; host-data.ts keeps only records the holder produced (`meta.json`/activity `host`, unstamped = holder), so copies count once. `/api/stats/activity` and `/api/stats/costs` add `hosts[]` beside combined totals. Other hosts are read-only in the UI (`readOnly` on jobs).
- `GET /api/runs/:jobId/:runId/log?offset=&file=` — incremental log content (`file=session`: the run's `session.log`, the inner Claude session text of a script run; run summaries carry `innerSessions`)
- `GET /api/runs/:jobId/:runId/graph` — run diagram data (from `trace.jsonl`, drawn as an agent run; reconstructed from `output.log` for older runs and script runs without an inner session)
- `POST /api/runs/:jobId/trigger` — manual job trigger
- `POST /api/reload` — force config reload
