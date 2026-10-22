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

The Dashboard's Lifetime Activity totals and daily trend use a durable activity ledger in `data/activity/<job-id>/<run-id>.json`, separate from retained run logs. Each small record contains the run identity, start time, AI-session flag, tool-call count, and per-tool counts, plus the run's cost reports (job name, `costs.json`, `evaluation-cost.json`, `evaluation-decision.json`, and the evaluation's severity, follow-up flag and source); it does not copy prompts or logs. Keep this directory in backups.

- Completed runs are recorded automatically, even when the Dashboard is never opened. Retries contribute their combined tool count to one run record, not extra sessions.
- Existing retained runs are imported on daemon startup and reconciled on activity reads. Repeated imports replace the same run record rather than double-counting it. Already-pruned history cannot be recovered.
- Before pruning a run, the daemon must successfully preserve its activity. Running, unreadable, or unpreservable runs are kept for a later attempt. Activity records are atomically replaced and are not subject to `retain_runs`.
- Lifetime totals, daily UTC buckets, and top-tool counts survive log pruning and daemon restarts. In-progress runs remain provisional until completion. Invalid preserved records produce an error rather than silently reporting smaller totals.
- Running-log backfills are not persisted. Native counters are marked finalized and written before terminal status; recovery discards old provisional caches before importing interrupted runs. A valid preserved record takes precedence over log reconstruction when native stats are damaged or missing.
- Coverage is unchanged: sessions mean native Claude job runs, including failed runs; script-internal AI calls and evaluator calls are not included. Historical tool-count limitations are not repaired by this migration. Cost totals read the same records once a run is pruned (see Costs and Usage).

Restart the daemon after upgrading to activate automatic activity preservation and import the available history.

## Costs and Usage

The Dashboard shows reported USD costs for today, this month, and retained history, plus a 7/30/90-day daily trend and job ranking. Daily and monthly boundaries use **UTC**. Jobs show totals across their retained history; run details break down execution, retries, script tasks, evaluator overhead, and reported model/token usage.

Model labels accompany costs in recent runs, the run list, job cards, and the selected-period Dashboard overview and ranking. They show exact **reported execution model IDs**, deduplicated across tasks and retry attempts; evaluator models appear separately on run details and never count as execution models. Job totals include models from their whole retained history, while Dashboard period labels follow the selected date range. Missing reports display **Models unavailable**. A **Configured model** fallback is not evidence of actual usage: run fallbacks come from that run's saved configuration, not today's job settings.

- Native Claude jobs automatically capture `total_cost_usd` and usage from their structured result. Cumulative results replace prior reports within an attempt, while retry attempts add together. Parent session totals already include native subagents; their results are not added again. Separately launched CLI/API calls inside tools are not automatically attributed.
- **Script runs with an inner Claude session** (autopilot's stage-2 and babysit sessions, found as described under Web UI) are costed from that session's transcript since 2026-10-16: every API call's token usage and model are exact, and the dollars are the model's **list price** from `src/shared/model-prices.ts` (the table bundled in the claude CLI, read 2026-10-16; cache writes priced by TTL, Haiku 5.5's long-prompt tier applied). Subagent calls count. A model the table does not list (a new release, a `-fast` variant) is not guessed: its tokens show and its dollars read unavailable, which keeps the attempt partial. `sessions.json` carries the per-model usage and cost; the ledger's `executionCostUsd` and `executionModels` are filled from it. Until then every autopilot run said null.
- The post-run Haiku evaluation is tracked separately, even when its assessment cannot be parsed. An evaluation still running is marked pending.
- The Jev decision model (TypeSafe System One, used by the evaluator when `evaluator.decision_model` is `shadow`, `enforce` or `benchmark`) has its own metric: the Dashboard's **Jev decisions** row shows requests, input tokens and spend for today, this month, retained history and the selected period, and run details show the per-run decision cost, tokens and model. Spend is the provider-reported `usage.cost` per request (output tokens are free); a request whose provider reported no charge counts as usage with spend unavailable. Decision spend is included in run totals when known. The same card shows **estimated savings** (Haiku spend Jev avoided or would avoid, minus Jev spend: shadow runs count the Haiku cost of runs Jev judged clean, enforce runs without a Haiku call count the retained-history average Haiku evaluation cost), **Haiku calls skipped**, and **agreement with Haiku** on shadow and benchmark runs (severity and follow-up), so quality can be watched while cost comes down.
- **Evaluation ledger.** Every evaluated run appends one JSON line to `data/evaluations/YYYY-MM.jsonl`: job, run, trigger (and the missed slot for catch-ups), status, exit code, duration, execution cost and models, the Haiku verdict and cost, the Jev decision (severity probabilities, confidence, follow-up probability, failure kind, latency, tokens, cost, error) and whether the two agreed. Run directories are pruned after `retain_runs`; the ledger is not, so it is the place to study schedules, follow-up rates and Jev-vs-Haiku quality over months. A record is about 1.5 KB (roughly 3 MB a month at 60 runs a day); `evaluator.log_retain_months` (default 12) deletes older month files. The weekly ai-researcher job reads it.
- **Switching to enforce.** `npm run jev:report` (optionally `-- --days 3`, `--json`, `--min-compared 30`) reads the ledger and prints compared runs, severity and follow-up agreement, a Haiku-vs-Jev confusion matrix, per-job figures, Jev latency, spend, estimated savings, the runs only Haiku or only Jev flagged for follow-up (both listed for adjudication; neither model is counted as wrong), and how many enforce-mode Haiku second opinions ran and raised a follow-up. It ends with READY or NOT READY (defaults: at least 50 compared runs, follow-up agreement 90% or better, no missed criticals) and exits non-zero when not ready, so it can gate a script. When it says READY, set `evaluator.decision_model: enforce` and apply it with `curl -s -X POST http://127.0.0.1:3501/api/reload` (the file watcher is not reliable for this; the API reload is). To keep measuring Jev once it decides, use `decision_model: benchmark`: Jev still decides, and Haiku judges every run beside it, so the report's compared runs keep growing (at about one Haiku evaluation per run). "Agreement" compares Jev with Haiku on the same run, and Haiku is a non-deterministic baseline that produces its own false positives, so a disagreement is something to adjudicate against the log or the outcome, not a Jev error by definition. `npm run jev:replay -- --ledger data/evaluations/YYYY-MM.jsonl --roots data/runs --variant questions.json` replays the retained runs through the shipped questions and an alternative set, so a wording or threshold change is measured on real logs before it ships (2026-10-15: the stand-down wording, the 0.6 threshold and the 0.55-0.65 band came from one).
- These are **reported API-equivalent estimates, not subscription invoices or payment charges**. The only price table is the list-price one for inner sessions above; everything else is provider-reported. External provider charges, subscription fees, and unreported nested work are excluded.
- Missing, corrupt, historical, or uninstrumented usage is **unavailable**, not $0. Partial totals include only known amounts. Dashboard coverage shows how many runs report costs; averages use those tracked runs and can include partial totals. Interrupted attempts without a final cost result remain unavailable.
- Totals cover **retained history**, not lifetime billing: retained runs plus the costs of pruned runs, which the pruner keeps in each run's activity record (`data/activity/`) before deleting the run directory. Runs pruned before costs were preserved still count, as runs with no reported cost, so their days and jobs show partial coverage instead of a smaller total that looks complete. All runs contribute, independently of the run list's pagination. An old run's direct URL still loads its cost details while the run is retained.

New runs write `costs.json` alongside `meta.json` and `status.json`. Evaluation costs live in a separate `evaluation-cost.json` so the evaluator and runner do not overwrite each other's data, and Jev answers plus usage live in `evaluation-decision.json`. Cost files are atomically replaced. Existing runs are not assigned guessed prices or modified to backfill dollar amounts.

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

Restart the daemon after installing this code to enable capture for subsequent runs. Hot-reloading `scheduler.yaml` alone does not load code changes. `curl -s -X POST http://127.0.0.1:3501/api/drain` lets the running runs finish first: the daemon starts nothing new, exits once none is left, and the LaunchAgent brings up the new code (see the desk-host README; `deploy-air.sh` does this). No paid jobs need to be triggered to enable the feature.

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
  timeout: 300 # seconds per job
  max_retries: 0 # extra attempts on failed/partial runs (timeouts are never retried)
  retain_runs: 50 # how many runs to keep per job
  priority: background # background (default) runs each job's process tree under `taskpolicy -c background`
  # on macOS (`nice -n 19` elsewhere), so it yields CPU and I/O to whatever you are doing and runs at
  # full speed only on an idle machine; normal runs it unclamped

evaluator:
  decision_model:
    off # off (Haiku only) | shadow (Haiku decides, Jev recorded beside it) | enforce (Jev decides,
    # Haiku writes summaries for warning/critical/follow-up runs, and Sonnet gives a second opinion
    # (and the summary) when Jev's P(follow-up) is 0.55-0.65 (a follow-up from 0.6; both set
    # 2026-10-15 from a replay of retained runs; Sonnet since 2026-10-16): the more severe label and
    # either follow-up win. A run deferred by its precondition is rated ok by the scheduler itself,
    # without any model call. Jev reads the
    # log without MCP connector notices (cognee/oncrawl/context7 status) | benchmark (Jev decides
    # exactly as in enforce, and Haiku still judges every run in parallel; its verdict is recorded
    # beside Jev's as `haikuBenchmark` for jev:report and the dashboard, never applied beyond the
    # second-opinion band; costs about one Haiku evaluation, ~$0.08, per run). Jev needs TYPESAFE_API_KEY,
    # TYPESAFE_BASE_URL and TYPESAFE_DEFAULT_MODEL in the daemon's environment (the gitignored .env
    # sources ~/.claude/.secrets/typesafe.env; scripts/start-daemon.sh, `npm run daemon` and
    # `npm run daemon:watch` all load .env). Spend appears as its own "Jev decisions" metric.
  log_retain_months: 12 # months of the evaluation ledger (data/evaluations/YYYY-MM.jsonl) to keep

hosts: # optional: one scheduler.yaml for several Macs (see "Several Macs, one file")
  D6H4HDF0Y4: groupon-mac-16 # the Mac's LocalHostName -> role name
  FL2R12XFMX: { role: groupon-mac-air, ssh: desk } # ssh: alias the Hosts page checks it through

jobs:
  my-job:
    name: "My Scheduled Job"
    schedule: "0 9 * * 1-5" # cron expression (weekdays at 9am)
    directory: /absolute/path/to/project # working directory for claude
    runs_on: groupon-mac-air # required once hosts is declared: a role, a list of roles, or all
    prompt: | # what claude should do
      Run the daily health check:
      1. npm test
      2. npm audit
      Report any failures.
    enabled: true
    model: sonnet # optional: sonnet, opus, haiku
    timeout: 600 # optional: override default
    catchup: same-day # optional: always (default), same-day, never
    priority: normal # optional: background (default, from defaults.priority) or normal
    skip_permissions: true # optional: --dangerously-skip-permissions
    precondition: bash scripts/precondition-autopilot-lock.sh # optional: runs first; exit 75 defers the run
    precondition_timeout: 60 # optional: seconds the precondition may take (default 60)
    retry_after: 600 # optional: seconds before a deferred slot is retried (default 600, twice at most)
    outcome_codes: { blocked: [30] } # optional: exit codes that mean "waiting on a person"
    uses_claude: true # optional, script jobs: the script starts a Claude session (held with the Claude jobs by the usage hold)
    tags: [daily, health] # optional: for filtering in the UI
```

Keep `timeout` under the job's schedule interval (the hourly review jobs use 3540, the half-hourly answer-pr-comments 1740): a run killed at exactly the interval is still being torn down when the next tick fires, the daemon skips that tick as "previous run still active", and with `catchup: never` the slot is gone. Every run gets `SCHEDULER_DEADLINE`, the ISO instant it will be killed at, so a job can stop starting work it cannot finish (the review rounds do).

#### Preconditions, deferred, blocked and killed runs

A `precondition` is a shell command the daemon runs in the job's directory, with the job's environment (`SCHEDULER_TRIGGER`, `SCHEDULER_JOB_ID`, `SCHEDULER_RUN_ID`, `SCHEDULER_DEADLINE`, and `SCHEDULER_CATCHUP_FOR` on a catch-up), before the job's command or Claude session starts. Its output goes to the run's `output.log`. Exit 0 lets the job run. Exit 75 (`EX_TEMPFAIL`, "not now") records the run as **deferred**: nothing ran, no cost, the evaluator rates it ok without a model call, and the daemon retries the same slot after `retry_after` (default 10 minutes), twice at most, through the catch-up queue; the retry is a `catchup`-triggered run of the slot with `deferredRetry` 1 or 2 in `meta.json`, ignores the job's `catchup` policy (it is the slot's own run), and is dropped if the job runs anyway first. A manual run is not retried. Any other exit, or a precondition past `precondition_timeout`, records the run as **failed** with the output, and the job does not run. Until 2026-10-16 the review-round jobs asked the model to check the autopilot lock, which started a Sonnet session per hour just to print "deferred"; `scripts/precondition-autopilot-lock.sh` and `scripts/precondition-air-load.sh` (lock, free memory, builds or tests from another job) do that first now. Since 2026-10-16 the Air-load one also holds the autopilot back while the Mac is busy or at risk: kernel memory pressure at warn or critical, more than 4 GB of swap in use, a 5-minute load average above twice the core count, or recorded CPU throttling below 70% (`AUTOPILOT_MAX_SWAP_MB`, `AUTOPILOT_MAX_LOAD_PER_CORE`, `AUTOPILOT_MIN_CPU_SPEED_PCT` tune these). The review rounds are not held by it; they are the Air's purpose.

`outcome_codes.blocked` lists the exit codes that mean the job handed its work to a person (the autopilot's exit 30: a PR that needs its author, a ticket the flow handed back). Such a run is **blocked**: amber in the UI, counted apart from failures, not retried; the evaluator still runs. A run whose process ends on a signal, without an exit code (the daemon stopped, a SIGKILL), is **killed** rather than failed with `exit=None`; the orphan cleanup at daemon start marks a run it finds still `running` the same way. Neither is retried.

#### The usage window: hold and headroom

When the Claude account's 5-hour or 7-day window is used up, `claude -p` prints one line ("You've hit your weekly limit · resets Oct 18 at 5am (Europe/Prague)", or "session limit · resets 12:30pm") and exits 1, and every Claude job on that Mac fails the same way until the reset (fourteen runs across four jobs on 2026-10-16 06:00-09:50Z). Since then a failed run whose output carries that line is **blocked** with `blockedReason: usage-limit` instead (rated warning by the scheduler, no model call, no retry), and the daemon holds every job that starts a Claude session - claude-type jobs, and script jobs marked `uses_claude: true` (autopilot-daily, autopilot-babysit) - until the reset plus a minute, or 30 minutes when the reset text is not understood. A held tick writes no run (one line in the daemon log, a `skipped` count on the hold) and is queued under the job's `catchup` policy, so a daily job runs after the reset and an hourly `catchup: never` job simply waits for its next slot. Janitors, discovery, reconcile and the headroom gauge keep running. Manual triggers of held jobs are refused with the reset in the message. The hold is `data/usage-hold.json` (kept across restarts), shows on `/api/health` and as an amber banner in the UI on both Macs, and `curl -X POST 127.0.0.1:3501/api/usage-hold/clear` lifts it early.

The `usage-headroom` job (`scripts/usage-headroom.py`, every 30 minutes, every host) samples the account's windows - the figures Claude Code's `/usage` shows - into `data/usage/latest.json` and `data/usage/headroom.jsonl`, shown on the dashboard's "Claude usage window" card. It reads Claude Code's OAuth token from the login keychain (so it works under the LaunchAgent, not over ssh) and never prints it; any failure is a sample with `status: unavailable`. The response shape is not documented: the card shows whatever windows the sample carries, and the raw body stays in `latest.json`.

Every sample also carries a **pace** (2026-10-22, after the Air's account spent its week in 60 hours): the 7-day allowance left per remaining hour against the nominal 100 points over 168 hours, as a factor clamped to 0.25-2.0 - 1.0 on budget, below 1 when the week is being spent too fast (`hot`), above 1 with budget to spare (`spare`), and at most 0.5 while the 5-hour window is 85% used or more. The pr-review skill's scheduled rounds multiply their `rate_limit` (8 PRs per run) by that factor, bounded to 2-16, so a hot week reviews fewer PRs per hour - re-reviews first - and a quiet week more; a missing or stale sample, or a manual run, keeps the plain 8. The card shows the pace under the windows. No 7-day figure or reset time means `unknown` at 1.0.

#### Missed runs and catch-ups

If a slot does not run (the machine slept, the daemon was down, the previous run was still going, or node-cron dropped a tick that fired a second late), the daemon runs one catch-up per job for the latest missed slot of the last 24h. It checks at startup, after a sleep gap, and every 30s. A job has at most one catch-up queued at a time, and a queued catch-up is dropped if the job runs anyway (on schedule or manually) before its turn. Each catch-up first waits up to 10 minutes for the network (a connection to `api.anthropic.com`), which is often still down right after the machine wakes; if it stays down, the catch-up runs anyway and fails visibly. A catch-up run gets `SCHEDULER_TRIGGER=catchup` and `SCHEDULER_CATCHUP_FOR=<missed slot, ISO>`. Scheduled and manual runs get `SCHEDULER_TRIGGER=scheduled|manual` and no `SCHEDULER_CATCHUP_FOR`. Use it to work on the slot's date instead of "today".

`catchup: same-day` suits jobs that act on "today" or "tomorrow". It skips a catch-up that would start on a later local calendar date than its missed slot. `catchup: never` skips every catch-up. Skips are logged in the daemon log. A tick that fires while the job's previous run is still active (a timeout's teardown included) is skipped and queued the same way, which is why a job's `timeout` stays under its interval.

#### Several Macs, one file

Declare `hosts:` (host name to role name) and give every job a `runs_on:` (a role, a list of roles, or `all`). Each daemon looks its own host up in `hosts` (the Mac's `LocalHostName` from `scutil`, falling back to `os.hostname()` without `.local`; `AI_SCHEDULER_HOST` overrides it. `os.hostname()` alone is not used on macOS because it follows the network: after a reboot on 2026-10-15 it read `Mac`) and loads only the jobs whose `runs_on` names its role. The others do not exist on that Mac: no cron task, no catch-up, not in the UI. The health endpoint and `data/daemon.json` report the resolved `host`. A host that is not declared is a config error, so a stray daemon never doubles the work; a job without `runs_on` is a config error too. Without `hosts:` the file behaves as before and `runs_on` is ignored. Role names are lowercase letters, digits and dashes.

The web UI's **Hosts** page (`/hosts`, `GET /api/hosts`) lists every declared host with the jobs placed on it and its daemon's health, polled every 15 seconds. The daemon answers for its own host; for another host it runs `ssh <alias> curl .../api/health` with the alias from that host's `ssh:` entry, so the Mac serving the page needs key access to the others. A host without `ssh:` shows as not checked. Job cards also show each job's `runs_on`, and the sidebar shows this daemon's role.

**Seeing the other Macs.** Every five minutes a daemon that can reach another host over its `ssh:` alias pulls that host's `data/runs`, `data/activity` and `data/research` into `data/hosts/<name>/data/` and pushes its own into the other host's `data/hosts/<self>/data/`, so each web UI has both. Each run records the host that ran it (`meta.json` `host`), and a run is counted only for the host that produced it, so copied history is never counted twice; `scripts/stamp-run-hosts.ts` stamps runs from before this existed. The sidebar's **Showing** switch picks this Mac, another host or both. Another host is read-only: no Run or On/Off, and a colored banner says whose data is on screen. Each host keeps one color everywhere (`--host-1` blue, `--host-2` magenta, by `hosts:` order). The lifetime activity and cost panels always show every host, stacked by color with per-host totals. The timeline groups its rows under the Mac that schedules them, and every job row and job card says where it runs (one Mac or both). A job that moved shows its earlier runs in its row, outlined in the color of the Mac that ran them; an empty past slot is marked missed, or shown faint when it predates the oldest run still kept (each job keeps only its latest `retain_runs`). The API takes `?host=<name>|all` on `/api/runs`, `/api/jobs` and the run, log and graph endpoints (default: this host); `/api/stats/activity` and `/api/stats/costs` add a `hosts` array beside the combined totals.

On one host's view the runs list shows the jobs placed on it; the runs page's checkbox adds that host's history of jobs that have since moved (`scope=all`).

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

| Expression     | Meaning                        |
| -------------- | ------------------------------ |
| `0 9 * * 1-5`  | Weekdays at 9:00 AM            |
| `0 6 * * *`    | Every day at 6:00 AM           |
| `0 7 * * 1`    | Every Monday at 7:00 AM        |
| `0 9 * * 1,4`  | Monday and Thursday at 9:00 AM |
| `0 3 * * 0`    | Every Sunday at 3:00 AM        |
| `*/30 * * * *` | Every 30 minutes               |

## Web UI

The dashboard at http://localhost:3500 shows:

- **Dashboard** — stat cards, recent runs, job overview with manual trigger buttons
- **Jobs** — full job list with tag filtering and "Run now" buttons
- **Run History** — filterable table of all runs across all jobs
- **Catch-ups** — a run that caught up a missed slot carries a "↻ caught up" badge whose tooltip names the slot and how late it started. The dashboard's **Caught-up runs** section lists what is waiting or running now and the catch-ups of the last 7 days; while catch-ups are waiting or running, the sidebar shows "↻ N" next to Runs. Both link to Run History filtered by **↻ Catch-ups** (`/runs?trigger=catchup`). Restart the daemon so `GET /api/runs` accepts `?trigger=`; until then the UI filters in the browser, over the latest runs only.
- **Log Viewer** — click any run to see its output (live-tailing for active runs)
- **Claude session** — a script run that starts its own `claude -p --session-id <id>` (autopilot's b2c-toolkit runs) logs only a few status lines; the work is in that session. The daemon finds the session id in the run's output, copies the session's text into `session.log` and its trace into `trace.jsonl` (every 15 s while it runs, once at the end), and the run page opens on a **Claude session** tab; the Diagram then shows the session's steps. The files travel with the host sync, so either Mac shows them. `npx tsx scripts/ingest-inner-sessions.ts` backfills finished runs whose transcripts are still in `~/.claude/projects` on that Mac.
- **Run Diagram** — the run page's **Diagram** tab (`?view=diagram`) shows what the run did: each step, its tool calls with outcome and timing, errors with their messages, subagents nested under the call that spawned them, retries, and the final result. It updates live while the run is going. Claude runs recorded before tracing, and script runs, are reconstructed from `output.log` (script runs are split into sections on `=== title ===` lines); the view says when outcomes or nesting were not recorded. Restart the daemon after installing this code so new runs are traced and the `GET /api/runs/:jobId/:runId/graph` endpoint exists.
- **Config** — read-only view of the current `scheduler.yaml`

### Manual Triggers

Click "Run now" on any job card or in the jobs list to trigger an immediate run. The output appears in the runs table and can be watched live.

## Data Directory

All runtime data lives in `data/` (gitignored):

```
data/
├── daemon.json              # daemon health (pid, port, heartbeat)
├── activity/
│   └── <job-id>/<run-id>.json # durable activity counters and costs, never pruned with logs
├── runs/
│   └── <job-id>/
│       ├── <run-id>/
│       │   ├── meta.json    # job config snapshot + trigger type
│       │   ├── output.log   # claude's stdout/stderr
│       │   ├── trace.jsonl  # tool-call trace for claude runs and inner sessions (drives the Diagram tab)
│       │   ├── session.log  # a script run's inner Claude session text (Claude session tab)
│       │   ├── sessions.json # the inner sessions found: id, cwd, transcript, counts, per-model usage and list-price cost
│       │   └── status.json  # running/success/partial/failed/timeout/deferred/blocked/killed + exit code
│       └── latest -> <run-id>
└── daemon.log               # daemon process stdout
```

Old runs are automatically pruned based on `retain_runs` in the config, after their activity counters and costs have been preserved in `data/activity/`.

## Janitor (leftover processes and caches)

`npm run janitor` reports dev servers and MCP servers left running after their session ended, and how much the package caches could give back. Without `--apply` it stops and deletes nothing; `--processes` or `--disk` limits it to one half.

```bash
npm run janitor                     # report only
npm run janitor -- --processes --apply
npm run janitor -- --disk --apply
```

A process tree is stopped only when all of this holds (`src/janitor/processes.ts`):

- it hangs off launchd with no terminal, IDE or Claude session in it, so whatever started it is gone;
- it is a dev server (`next dev`, vite, nx, `npm|bun|pnpm|yarn run dev|serve|preview`) or an MCP server. Nothing else is ever a candidate;
- it is older than `min_age_minutes` (default 120), an earlier run already saw it, and it used less than `max_cpu_seconds_per_hour` (default 120) since. A detached server someone still uses keeps burning CPU and is reported as `BUSY`;
- nothing protects it. Always protected: the scheduler daemon and every job it is running, this project's own dev server, anything launchd runs as a service, Pilot's worker, and the `protect` list in `janitor.yaml` (command patterns, ports, directories).

Stopping means SIGTERM, ten seconds, then SIGKILL, with a pid and start-time check before every signal. The first sighting of a tree is always `OBSERVE`: the run writes its CPU total to `data/janitor/state.json` and the next run compares.

The disk half runs each cache's own cleaner (`uv cache prune`, `pnpm store prune`, `npm cache verify`, Docker dangling images and build cache older than 7 days) and removes directories nothing touched for `max_age_days` under the `disk.expire` paths (default: the pr-review skill's per-PR checkouts, which it re-creates on demand).

Two jobs in `scheduler.yaml` run it on weekdays: `janitor-processes` (10:45, 13:45, 15:45) and `janitor-disk` (12:20). They are report-only until `--apply` is added to their command.

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
