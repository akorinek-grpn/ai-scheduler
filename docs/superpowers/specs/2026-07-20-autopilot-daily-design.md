# Autopilot Daily — Design

**Date:** 2026-07-20
**Status:** Approved (design), pending implementation plan

## Summary

A weekday scheduled job that triages the MBNXT Jira backlog, picks at most one
low-to-medium complexity ticket that autopilot can plausibly finish unattended,
and runs the full autopilot pipeline against `next-pwa-app`. A companion
TanStack dashboard records every run — including every ticket that was
_considered and rejected_ — so the pipeline can be investigated after the fact.

Two deliverables:

1. One new job in the existing `ai-scheduler`, plus a script and prompt in a new
   `autopilot-daily/` project.
2. `autopilot-daily/web/` — a TanStack Start dashboard over the run store.

## Motivation

Autopilot already takes a Jira ticket from "To Do" to "Ready to Review". What it
lacks is a _feed_: someone has to choose a ticket and start it. This closes that
loop for one ticket a day, with triage strict enough that the bot declines more
often than it accepts.

The safety model matters here. The run is fully unattended — both of autopilot's
human gates (Phase 1 validate, Phase 2 plan approval) are auto-passed. That means
**triage strictness is the only pre-PR safety valve**, and the human checkpoint
moves to reviewing the draft PR that autopilot opens. The rubric below is
calibrated accordingly: it is designed to reject.

## Constraints discovered during design

These shaped the design and are recorded so they are not re-litigated:

- **The eligible pool is small.** Filtering only to _unassigned + not-a-Spike_:
  board 8872 has 11 open items, board 9841 has 7. After the "implementable in
  `next-pwa-app`" gate, the realistic pool is roughly 6–8 tickets. Idle days are
  an expected outcome, not a bug.
- **An `Autopilot_AI` label convention already exists.** ~30 MBNXT tickets carry
  it, near-exclusively Bugs, and they demonstrably flow through the pipeline
  (several sit in `Code Review`, `Ready to Merge`, `Released`). Almost all are
  assigned to a named human. It is used as a _second-tier_ feed, unassigned only.
- **`babysit-prs` occupies most of the working day.** `0 6-22 * * 1-5` with a
  1500s timeout — every hour on the hour, 06:00–22:00, up to 25 minutes. Any
  daytime schedule contends with it.
- **The machine sleeps overnight**, so the otherwise-ideal 22:30–06:00 window is
  unavailable.

## Architecture

```
ai-scheduler/scheduler.yaml
  └─ job "autopilot-daily"  (type: script, schedule: 30 9 * * 1-5)
       └─ autopilot-daily/scripts/run-daily.sh
            acquire lock  ~/.autopilot-daily.lock  (PID + start ts, trap-released)
            stage 1  claude -p < prompts/triage.md      → pick + full ledger → store
            stage 2  cd next-pwa-app && claude -p "/autopilot <KEY> --worktree"
            stage 3  append outcome (phase reached, PR URL, failure) → store
            release lock

autopilot-daily/
  ├─ scripts/run-daily.sh
  ├─ prompts/triage.md
  ├─ data/store.sqlite
  └─ web/                    TanStack Start dashboard (port 3600)
```

`ai-scheduler` gains one job and one prompt edit (the lock check in
`babysit-prs`). Nothing else in it changes.

### Why a script job rather than one prompt

Triage is a ~5 minute read-only scan; autopilot is a potentially 90-minute
implementation. Splitting them into two `claude -p` calls inside one shell script
gives distinct exit codes per stage, keeps a triage bug visually distinct from an
implementation bug in the log, and — critically — **persists the triage ledger
even when stage 2 dies**.

### Exit codes

| Code | Meaning                                                                       |
| ---- | ----------------------------------------------------------------------------- |
| 0    | Ran correctly — either shipped a PR **or** correctly found no eligible ticket |
| 20   | Triage error (Jira unreachable, malformed response)                           |
| 30   | Autopilot failed mid-pipeline                                                 |

**"Shipped" and "no eligible ticket" both exit 0.** Both are correct outcomes of a
healthy run; the store distinguishes them and the dashboard reads the store.

This is not cosmetic. `scheduler.yaml`'s `defaults` set `max_retries: 3`, and
`ai-scheduler` treats _any_ nonzero exit as failed and retries. An idle day
exiting nonzero would trigger three full re-runs of a job that had correctly
decided to do nothing.

The job therefore sets **`max_retries: 0`** explicitly, overriding the default.
Retrying a failed autopilot run burns 90 minutes on a pipeline that needs human
inspection, and a triage failure is cheap to pick up the next morning. The script
instead retries _stage 1 only_, once, on a transient error — the single case
where a retry is both cheap and likely to succeed.

### Worktree

`--worktree` is mandatory. `next-pwa-app` is a live checkout sitting on `main`;
an unattended run must never touch the working tree.

## Scheduling and the cooperative lock

**Schedule: `30 9 * * 1-5`** (09:30 weekdays).

With `babysit-prs` deferred by the lock, the next contenders are
`market-researcher` (12:00 Mon/Thu) and `afternoon-sync` (15:00). A 09:30 start
finishing by ~11:00 clears both; `setup-health` (09:00 Mon) has finished by
09:10. The machine is reliably awake during working hours. Timeout: 5400s.

**Lock protocol:**

- `run-daily.sh` writes `~/.autopilot-daily.lock` containing its PID and start
  timestamp; a shell `trap` removes it on every exit path.
- `babysit-prs`'s prompt gains a first instruction: check the lock; if present
  **and under 90 minutes old**, print `Deferred — autopilot-daily holds the lock`
  and stop without reviewing any PRs.
- The staleness bound is load-bearing. Without it, a single crashed run silently
  disables PR review indefinitely.
- `run-daily.sh` also refuses to start if a _fresh_ lock is already held.

**Known weakness — accepted.** `babysit-prs` is a `type: claude` prompt job, so
this is a soft lock: an LLM honoring an instruction, not an enforced mutex. Worst
case it ignores the lock once and one hour of seventeen overlaps; it re-runs the
following hour regardless. **Upgrade path if logs show it misbehaving:** convert
`babysit-prs` to a `type: script` job wrapping `claude -p` behind a shell
`test -f` guard, which is deterministic. Not done up front because it
restructures a working production job for a failure that may never occur.

## Triage

### Ordering: first-fit from the top

The picker walks boards in **rank order and takes the first ticket that passes**.
It does not score the whole board and pick a winner — a high-scoring ticket at
rank 40 must not jump a passing ticket at rank 3. This preserves the boards'
existing prioritisation.

Order: board **8872** (SEO/AEO Scrum) → board **9841** (MBNXT Feature Pillar,
SHARED) → unassigned `Autopilot_AI`-labelled tickets on either board as overflow.

Cap: 25 candidates evaluated per board, to bound cost.

### Hard gates

Rejected outright, no scoring. Ordered cheapest-first so the expensive repo check
runs last.

| Gate                   | Rejects                                                                                                                                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Assigned to a human    | anything not Unassigned                                                                                                                                                                                                                                                                    |
| Mobile / mixed scope   | `Mobile app` component (present alone = mobile-only, present with a web component = mixed; both rejected — autopilot does not partial-deliver), or strong native-only markers (Detox / Expo / SauceLabs / React Native / `apps/mobile-expo` / `libs/mobile`). Mirrors autopilot Phase 1.0. |
| Not a code deliverable | `issuetype = Spike`, or summary starting Investigate / Evaluate / Review / Explore / Research / Begin discussion                                                                                                                                                                           |
| Insufficient AC        | description substance < ~50 chars — mirrors autopilot's /prd-routing threshold, keeping the headless run out of an attended requirements conversation. The model's `clarity` floor is the deeper judge.                                                                                    |
| Wrong state            | **allowlist, fail-closed** — only `Backlog` and `To Do` pass (normalised variants: `TODO`, `To-Do`, `Open`, `New`). Everything else rejects: `In Progress`, `Code Review`, `Approval`, `Ready to Merge`, `Released`, `Blocked`, `Won't do`, `Done`. An **unrecognised** status rejects.    |
| Already attempted      | present in the store, unless the prior failure was infra-only                                                                                                                                                                                                                              |
| Blocked paths          | auth, checkout/payments, `.github`, `next.config.*`, migrations, `CODEOWNERS`, `.env*`, `bun.lock`, `libs/core/security`                                                                                                                                                                   |
| Not in `next-pwa-app`  | triage must **grep the repo** and locate the named component or route — ticket text alone is not evidence                                                                                                                                                                                  |

The allowlist is fail-closed by design: if MBNXT adds a workflow state next
quarter, the bot declines rather than guessing.

The repo-evidence gate does the heaviest lifting — it is what excludes the Encore
backend work, `mpp-service-v2`, the LPAPI backfills, and the MCP server tickets
that dominate board 8872. Because it needs repo I/O it cannot live alongside the
pure gate functions; it is enforced instead as a mandatory `0` on the Localization
dimension whenever no file path can be confirmed, which the no-zero-dimension rule
turns back into a binary reject.

**Blocked paths are matched in two layers.** Layer 1 is the path list in the table
above. Layer 2 is the keyword list from autopilot's own
`skills/ai-validate/references/blocked-paths.md` § "CRITICAL: Keyword Detection"
(`Dockerfile`, `Kubernetes`, `Helm`, `GitHub Actions`, `Jenkins`, `CI pipeline`,
`OTLP`, `OpenTelemetry`, `Prometheus`, `Grafana`, `webpack config`, `deploy
script`, `Napistrano`, `DeployBot`), which infers infrastructure impact from ticket
text even when no path is named. Layer 2 is a deliberate superset: autopilot
rejects these downstream anyway, so catching them at triage saves a wasted run.

**Also gated: `project = MBNXT`.** Board 8872 carries issues from other projects —
a live query returned `LEGACYWEB-2065` — and those are not implementable in
`next-pwa-app`. Board membership is not a project filter.

### Scoring

Survivors only. Out of 100. **Accepted only when ALL four hold: total ≥70, no
dimension at zero, complexity band not `high`, and clarity ≥ the AC floor (13).**
The clarity floor mirrors autopilot's /prd-routing threshold — a ticket with thin
AC would trigger autopilot's attended Phase 1, which a headless run cannot
complete, so it is declined before it is ever picked.

| Dimension        | Max | Measures                                                                         |
| ---------------- | --- | -------------------------------------------------------------------------------- |
| Clarity          | 25  | concrete repro steps, or explicit acceptance criteria                            |
| Localization     | 25  | can name ≤3 files, confirmed present in the repo                                 |
| Testability      | 20  | a test can be written that fails before and passes after                         |
| Blast radius     | 20  | one surface. **Zero** if it touches shared design-system primitives or mass i18n |
| Self-containment | 10  | no new deps, no API/schema change, no design assets, no cross-team coordination  |

A zero on any single dimension is fatal regardless of total. A 95 that needs a
design asset is still undoable overnight.

Complexity band is recorded (`low` / `medium` / `high`); `high` never accepts.

### Circuit breaker

If **3 or more bot PRs are already open and unmerged**, the run stops before
triage and records a no-pick. Without this, a week of unreviewed AI PRs
accumulates silently.

### The ledger

Every rejected candidate is written to the store with the gate it hit or its full
score breakdown. This is not optional bookkeeping — it is the only evidence that
tells you whether the rubric is well-calibrated or simply strangling everything.

## Dashboard

### Stack

TanStack Start (Router, Query, Table), Vite, TypeScript, Tailwind, SQLite via
`better-sqlite3`. Dev port **3600** (clear of `ai-scheduler`'s 3500/3501).

TanStack Start rather than a plain SPA for a concrete reason: a browser-only SPA
cannot hold Jira/GHE credentials or call either API past CORS. Start's server
functions read the local SQLite and proxy live lookups, keeping tokens
server-side.

### Data model

Written by `run-daily.sh`, read by the dashboard.

- **`runs`** — date, exit code, outcome, picked ticket, circuit-breaker flag, duration
- **`candidates`** — every ticket considered: board, rank, gate hit _or_ five-dimension score breakdown
- **`phases`** — one row per autopilot phase per run (`validate`, `plan`, `implement`, `review`, `test`, `babysit`) with status, duration, failure text
- **`tickets`** — one row per ticket ever taken, with PR number/URL and last-known Jira + PR state

History lives in SQLite; ticket and PR state are refetched live by TanStack Query
on view, so nothing renders stale.

### Views

**Runs** (home) — TanStack Table, one row per run: date, outcome, ticket, phase
reached, PR state, `waiting on`. Sortable and filterable, so "every run that died
in `implement`" is one click. This is the entry point for backwards
investigation.

**Run detail** — the forensic view:

- _What passed_ — the six-phase timeline in order, each pass / fail / skipped with duration.
- _Why it failed_ — the failing phase carries autopilot's own error text, plus a deep link into `ai-scheduler`'s existing log viewer at `localhost:3500` for raw output. Logs are not duplicated.
- _The triage ledger_ — every candidate in board-rank order with its gate or score. Answers the question asked most often: _"why didn't it take MBNXT-35926?"_

**Tickets** — everything the bot has taken, with live Jira status and live PR
state. Explicit `waiting on`, derived rather than stored: `awaiting CI`,
`awaiting review`, `awaiting merge`, `changes requested`, `merged`,
`stalled >3 days`. The stall detection surfaces PRs everyone forgot.

**Rejected candidates** (first-class, top-level view — a user requirement, not a
sub-panel) — every ticket that was considered across all runs and declined:
gate-rejected or scored-below-bar. One row per candidate with board, rank, run
date, and the reason (gate name, or the five-dimension score breakdown with the
failing condition highlighted — `clarity 9 < AC floor 13`, `complexity: high`,
`localization 0`). Filterable by reason and by board. This is distinct from the
per-run triage ledger in _Run detail_: that shows one run's candidates; this
aggregates the full rejection history so "what does the bot keep passing over, and
why" is answerable at a glance. It is the primary calibration surface and the
main audience-facing artefact — the honest record of what the strict triage turned
down.

**Triage insights** — aggregates over the rejected-candidates data: which gate
rejects most, score distribution, accept rate over time. If the `not in
next-pwa-app` gate (via Localization 0) or the new `insufficient_ac` gate kills
most candidates, the boards or the AC bar are wrong for this — learnable from data
in week two, not guessed at.

**About / How it works** (a user requirement — "all this has to be communicated")
— a static in-app page that explains, in plain language, what the bot does and its
known limits, so a viewer who is not the author understands the ledger they are
looking at. It must cover: the daily flow (triage → pick → autopilot → PR); the
full rubric (every hard gate and the five scoring dimensions, with the accept
rule — ≥70, no zero dimension, complexity ≠ high, clarity ≥ AC floor); **why
tickets get rejected** (the same reasons the Rejected-candidates view shows,
explained); and the **attended-Phase-1 limitation** — that autopilot is designed
to be attended through Phase 1, the daily job runs it headless anyway, the AC
floor and web-only gate exist specifically to keep Phase 1 silent, and some runs
will still fail when Phase 1 asks a question no one can answer. This page is how
the design's decisions and constraints reach anyone reading the dashboard, not
just whoever was in this conversation.

### Out of scope

No auth, no deploy, no notifications — a localhost tool for one person. No log
storage (`ai-scheduler` already has a viewer worth linking to). No write actions
against Jira or GitHub: the dashboard observes, autopilot acts.

## Testing

- **Triage rubric** — unit tests over the gate functions with fixture tickets drawn from real board data, including the fail-closed unknown-status case and the zero-dimension-is-fatal rule.
- **Store** — round-trip tests for run/candidate/phase/ticket writes, including the partial write when stage 2 dies after stage 1 succeeded.
- **Lock** — acquire, trap-release on signal, stale-lock expiry past 90 minutes, refusal to start on a fresh lock.
- **Exit codes** — each of 0/20/30 produced by the matching scenario, including that an idle day exits 0.
- **Dashboard** — component tests for the derived `waiting on` states; the live Jira/GitHub fetches are mocked.

`run-daily.sh` gets a `--dry-run` that runs triage and writes the ledger without
invoking autopilot. That is the primary way to calibrate the rubric against the
real backlog before switching the job on.

## Rollout

1. Build triage + store + `--dry-run`. Run it against the live boards for several days with the job disabled. Read the ledger; tune thresholds.
2. Enable stage 2 with the schedule still disabled; trigger manually via `ai-scheduler`'s "Run now".
3. Build the dashboard against real accumulated data.
4. Enable the schedule.

The rubric is calibrated on real data before anything opens a PR.

## Identity and visibility

PRs are authored by the local `akorinek` GHE account, so nothing about the commit
author distinguishes a bot PR from a hand-written one. Two markers resolve this:

- **The store is authoritative.** The `tickets` table records exactly which
  tickets this job took. The dashboard's PR queries and the circuit breaker both
  count from the store — an exact set, not a heuristic.
- **`ai/<TICKET-KEY>` branch prefix** is the secondary signal, already produced by
  autopilot's own worktree setup (`git worktree add … -b ai/[TICKET-KEY]`). No
  change to autopilot needed. It also catches autopilot runs started by hand,
  which is useful context but deliberately _not_ what the circuit breaker counts.

**Jira write-back: yes.** When the job takes a ticket it posts a comment
(`Picked up by autopilot-daily run <date>` plus the PR URL once opened) and adds
an `autopilot-daily` label. This is not decoration — the job only takes
_unassigned_ tickets, and nothing otherwise prevents a human picking up the same
ticket mid-run. The comment is the claim signal a teammate would actually see.
Autopilot still owns the status transition to Ready to Review; the daily job does
not duplicate it.

This is the one exception to "the dashboard observes, autopilot acts" — the write
comes from `run-daily.sh`, not the dashboard, which stays read-only.
