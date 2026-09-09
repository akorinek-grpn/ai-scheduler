# Autopilot Daily Implementation Plan

Created: 2026-07-20
Author: akorinek@groupon.com
Agent: Claude Code
Status: VERIFIED
Approved: Yes
Iterations: 0
Worktree: No
Type: Feature

## Summary

**Goal:** Running `bun run triage --dry-run` produces a ledger explaining every
candidate on MBNXT boards 8872 and 9841 — which gate rejected it or how it
scored — and picks at most one ticket; with the full script enabled, that pick is
handed to autopilot against `next-pwa-app` and the outcome recorded.

## Out of Scope

- **The dashboard.** TanStack Start UI over this store is a follow-up plan, built once calibration has produced real data and the schema has settled.
- **Enabling the schedule.** The job ships `enabled: false`. Flipping it on is a deliberate user action after reading dry-run ledgers.
- **Modifying autopilot.** Its skills, agents and phase logic are consumed as-is. Only the `babysit-prs` prompt in `ai-scheduler` is edited, and only to add a lock check.
- **Widening the ticket pool.** The `Autopilot_AI` label is used unassigned-only as overflow. Revisiting the skip-assigned rule is a conversation with the label's curator, not code.

## Approach

**Chosen:** Split-responsibility triage — a bun/TypeScript module fetches via Jira
REST and applies the deterministic gates; `claude -p` handles only repo-evidence
and five-dimension scoring; `run-daily.sh` orchestrates and calls autopilot.

**Why:** The cheap gates (project, assignee, type, status, already-attempted)
become unit-testable code instead of prompt behaviour, and Jira access needs no
MCP — verified working today against `/rest/agile/1.0/board/8872/issue` with the
existing `CONFLUENCE_API_TOKEN`. The cost is two runtimes to reason about (shell +
TypeScript) and a JSON contract between the scoring prompt and the caller that
must be validated rather than trusted.

## Context for Implementer

`ai-scheduler` runs script jobs as `/bin/sh -c <command>` (`src/daemon/job-runner.ts:214`),
**not** bash — so the job command must invoke `bash run-daily.sh` explicitly rather
than relying on bashisms in the command string.

Its exit-code mapping (`src/daemon/job-runner.ts:316`) is `0 → success`,
**`2 → partial`**, anything else `→ failed`, and non-success statuses are retried
up to `max_retries`. Exit code `2` is therefore reserved and must never be used;
this plan uses `20` and `30`, and pins `max_retries: 0` (the file's `defaults`
set `3`).

Board 8872 contains issues from **other projects** — a live query returned
`LEGACYWEB-2065` alongside MBNXT tickets. A `project = MBNXT` gate is mandatory,
not implied by the board.

## Runtime Environment

- **Triage CLI:** `cd /Users/akorinek/Programming/autopilot-daily && bun run triage --dry-run`
- **Credentials:** `CONFLUENCE_EMAIL` + `CONFLUENCE_API_TOKEN` from the environment; Jira site derived from `CONFLUENCE_URL` (`https://groupondev.atlassian.net`)
- **Target repo:** `/Users/akorinek/Programming/next-pwa-app` (bun monorepo, currently on `main`)
- **GitHub:** `GH_HOST=github.groupondev.com gh` — already authenticated as `akorinek`

## File Structure

- `autopilot-daily/package.json` (create) — bun project, `triage` and `probe` scripts.
- `autopilot-daily/src/jira.ts` (create) — Jira REST client: board issues, add comment, add label. No filtering logic.
- `autopilot-daily/src/gates.ts` (create) — pure functions: deterministic hard gates. No I/O.
- `autopilot-daily/src/store.ts` (create) — `bun:sqlite` schema + read/write for runs, candidates, phases, tickets.
- `autopilot-daily/src/score.ts` (create) — spawns the scoring `claude -p`, validates its JSON, applies first-fit selection.
- `autopilot-daily/src/lock.ts` (create) — lockfile acquire/release/staleness.
- `autopilot-daily/src/breaker.ts` (create) — counts open bot PRs via `gh`, decides whether to run.
- `autopilot-daily/src/triage.ts` (create) — CLI entry: wires jira → gates → score → store.
- `autopilot-daily/prompts/triage-score.md` (create) — scoring prompt; the rubric text.
- `autopilot-daily/scripts/run-daily.sh` (create) — orchestration, exit codes, stage 2 autopilot call.
- `ai-scheduler/scheduler.yaml` (modify) — new `autopilot-daily` job; lock check in `babysit-prs`.

## Assumptions

- `CONFLUENCE_API_TOKEN` authenticates against Jira REST (verified 2026-07-20, HTTP 200 on board 8872) — Tasks 1, 2, 8 depend on this.
- Autopilot's Phase 2 plan-approval gate can be passed by an instruction in the wrapper prompt. **Unproven** — Task 7 depends on it, and Task 7's DoD is the first place it is actually tested.
- `claude -p` invoked from `next-pwa-app` can resolve the `/autopilot` skill — Task 7 depends on this.

## Risks and Mitigations

| Risk                                                                        | Likelihood | Impact | Mitigation                                                                                                                                           |
| --------------------------------------------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Autopilot ignores the unattended instruction and blocks on the Phase 2 gate | Medium     | High   | `timeout: 5400` kills it; stage 2 exits `30` and the store records the phase reached. Rollout runs stage 1 only until a manual stage-2 trial passes. |
| Scoring `claude -p` returns malformed or non-JSON output                    | Medium     | Medium | Zod-validate the response; on parse failure record a `score_error` candidate verdict and exit `20` rather than picking blind.                        |
| Eligible pool runs dry within ~2 weeks                                      | High       | Low    | Expected. A no-pick run exits `0` and writes the ledger; the aggregate makes exhaustion visible rather than silent.                                  |
| `babysit-prs` ignores the soft lock and runs concurrently                   | Low        | Low    | Costs one overlapping hour of seventeen; it re-runs the next hour. Upgrade path (script-wrapped hard guard) documented in the design doc.            |

## Goal Verification

### Truths

1. Every ticket on boards 8872 and 9841 that triage considered appears in the store with either the gate that rejected it or its five-dimension score — no candidate is silently dropped.
2. Re-running triage on a day when nothing qualifies exits `0`, writes a no-pick run row, and never invokes autopilot.

## Implementation Notes (2026-07-20)

**Pre-existing test failures in `ai-scheduler`, not caused by this change.**
`bun test` in `ai-scheduler` fails in `src/daemon/__tests__/job-runner.test.ts`
(timeout / SIGKILL-grace cases) and `src/daemon/__tests__/catchup.test.ts`. These
exercise `job-runner.ts` and `cron-engine.ts`, all three of which were already
modified in the working tree before this plan started — in-flight work on the
`sigkillGraceMs` feature. Evidence they are unrelated: neither failing test file
references `scheduler.yaml`, which is the only `ai-scheduler` file this plan
edits. They are left alone deliberately rather than "fixed", because guessing at
half-finished intent would risk destroying that work. **They need the user's
attention before the schedule is enabled.**

`autopilot-daily`'s own suite is green: 138 tests, 0 failures, `tsc --noEmit`
clean, plus a hermetic `scripts/__tests__/stage2-smoke.sh` (3 checks).

**Stage 2 reworked against the SLIM `/autopilot` (2026-07-21).** The original
stage 2 was built by reading the wrong autopilot on disk: the deprecated 7-phase
plugin skill at `~/.claude/cache/consumer-eng-ai-ops/plugins/autopilot/`, not the
slim pilot-shell wrapper at `~/.claude/commands/autopilot.md` that the Confluence
pages ("Autopilot with pilot shell" 82861424761, "Development for Everyone" setup
guide 82840387616) actually document and that `/autopilot` resolves to. The slim
contract differs in three ways now handled:

- **No flags.** Usage is `/autopilot <TICKET-KEY>`; the legacy `--worktree` /
  `--skip-validate` don't exist and would corrupt the ticket argument. Dropped.
- **Isolation is ours to guarantee.** The slim version delegates worktree to
  `/spec`'s Branch Strategy, which is OFF here, so it would otherwise run on the
  live `next-pwa-app` checkout. `run-daily.sh` now creates the `ai/<KEY>` worktree
  itself (from `origin/main`) and runs autopilot inside it — removed on success,
  kept on failure for inspection.
- **Unattended levers are env vars.** `PILOT_PLAN_APPROVAL_ENABLED=false`,
  `PILOT_PLAN_QUESTIONS_ENABLED=false`, `PILOT_BRANCH_ISOLATION_ENABLED=false` are
  set on the stage-2 `claude -p` call, not asked for in a prompt.

**Phase-1 mitigation gates added (2026-07-21).** To keep the headless run out of
autopilot's attended Phase 1, triage now also rejects: (a) mobile-only/mixed
tickets (`mobile_scope` gate — `Mobile app` component or strong native markers,
mirroring autopilot Phase 1.0), and (b) thin-AC tickets (`insufficient_ac` gate,
description < 50 chars, mirroring autopilot's /prd-routing threshold), plus a
`clarity ≥ 13` floor in the scoring accept rule. Caught one over-block bug in
review: the native marker `expo` matched `export` as a substring — fixed with
word-boundary matching (same class as the earlier `auth`/`author` bug). 152 tests
pass. The dashboard requirements from this decision — a first-class
**Rejected candidates** view and an **About / How it works** page that
communicates the rubric and the attended-Phase-1 limitation — are captured in the
design doc's Dashboard section for the follow-up plan.

**Accepted limitation (user decision 2026-07-21): fully headless despite an
attended Phase 1.** Per the setup guide, `/autopilot` Phase 1 (Validate) is
attended by design and may ask up to 10 questions; Phases 2–6 are unattended. A
headless run cannot answer Phase 1, so a ticket that triggers questions stalls to
the 5400s timeout and exits 30. Triage already vets hard, so many tickets pass
Phase 1 silently — the rollout measures the real pass rate. `acli` is NOT a hard
prerequisite: the slim autopilot falls back to the Atlassian MCP for Jira.

**Two defects found and fixed during live verification** (neither was in the
plan; both surfaced by actually running the thing):

1. The ledger read back in insertion order (gated-then-scored), interleaving
   ranks. Fixed by ordering on `boardId, rank` — the ledger is a forensic
   artefact and must read in board-walk order.
2. A `--dry-run` recorded its outcome as `shipped` despite handing nothing to
   autopilot. Added a distinct `picked_dry_run` outcome.

**Calibration signal from the first live dry runs** — the rubric is currently very
aggressive, which the rollout is meant to surface:

- 6 of 12 candidates were rejected by `blocked_path`, several on weak evidence
  (`MBNXT-33204`/`33211` on `.env`, `MBNXT-35295` on `migration`).
- Scoring is not stable run-to-run. `MBNXT-36995` scored 84/medium on one run and
  56/high on the next; the pick changed between runs. First-fit ordering is
  deterministic, but the scores feeding it are not.

## Progress Tracking

- [x] Task 1: Scaffold project and Jira REST client
- [x] Task 2: Deterministic hard gates
- [x] Task 3: SQLite store
- [x] Task 4: Scoring prompt and first-fit selection
- [x] Task 5: Lockfile
- [x] Task 6: Circuit breaker
- [x] Task 7: Orchestration script
- [x] Task 8: Jira write-back and ai-scheduler integration

## Implementation Tasks

### Task 1: Scaffold project and Jira REST client

**Objective:** Create the `autopilot-daily` bun project as its own git repository and implement the Jira REST client it depends on. The client fetches board issues via the agile API and exposes comment/label writes for later use, with no filtering or business logic of its own.

**Files:**

- Create: `/Users/akorinek/Programming/autopilot-daily/package.json`
- Create: `/Users/akorinek/Programming/autopilot-daily/src/jira.ts`
- Create: `/Users/akorinek/Programming/autopilot-daily/src/__tests__/jira.test.ts`

**Key Decisions / Notes:**

- `git init` the directory; add `.gitignore` for `node_modules/`, `data/`, `.env`.
- Site URL derives from `CONFLUENCE_URL` by stripping the path — do not hardcode.
- Basic auth: `CONFLUENCE_EMAIL:CONFLUENCE_API_TOKEN`. Throw a named error if either is unset so the caller can exit `20`.
- Endpoint: `GET /rest/agile/1.0/board/{boardId}/issue` with `jql`, `fields`, `maxResults`, `startAt`. Paginate until `startAt + maxResults >= total`.
- **`ORDER BY Rank ASC` is mandatory in every JQL string and must not be omitted or overridden.** Verified live 2026-07-20: the agile endpoint does NOT default to board rank. The same filter without `ORDER BY` returned `MBNXT-37001, 30182, 36995, …`; with `ORDER BY Rank ASC` it returned `MBNXT-30182, LEGACYWEB-2065, 33152, …`. Since the whole design rests on first-fit from the top of the board, a missing `ORDER BY` silently picks the wrong ticket.
- `fetchBoardIssues` must preserve response order end-to-end — no re-sorting, and pagination must append rather than merge.
- Tests mock `fetch` — no live network in the suite. A separate `bun run probe` script hits the real API for manual checks.

**Definition of Done:**

- [ ] `fetchBoardIssues("8872", jql)` returns every issue across pages, not just the first 50
- [ ] Given a mocked two-page response in a deliberately non-alphabetical order, the returned array preserves that exact order
- [ ] A JQL string lacking `ORDER BY Rank` is rejected (or has it appended) rather than being sent as-is
- [ ] Missing `CONFLUENCE_API_TOKEN` throws a distinguishable error rather than making an unauthenticated request
- [ ] Verify: `cd /Users/akorinek/Programming/autopilot-daily && bun test src/__tests__/jira.test.ts`

### Task 2: Deterministic hard gates

**Objective:** Implement the cheap, testable rejection gates as pure functions over an issue object. These run before any LLM call and reject the large majority of candidates, each returning a named reason that is recorded in the ledger.

**Files:**

- Create: `/Users/akorinek/Programming/autopilot-daily/src/gates.ts`
- Create: `/Users/akorinek/Programming/autopilot-daily/src/__tests__/gates.test.ts`

**Key Decisions / Notes:**

- Gate order, cheapest first: `project != MBNXT` → assigned → `Spike`/investigation-prefix summary → status not in allowlist → already attempted → blocked-path hit.
- **Status is a fail-closed allowlist.** Only normalized `backlog`, `to do`, `todo`, `to-do`, `open`, `new` pass. Any unrecognized status **rejects** — this is the behaviour to test explicitly, not an edge case.
- Investigation prefixes: `Investigate|Evaluate|Review|Explore|Research|Begin discussion|Discovery|Spike|POC` at the start of the summary, case-insensitive.
- **Blocked-path matching has two layers, and both are required.** Layer 1 — paths, verbatim from the design doc: `auth`, `checkout`/`payments`, `.github`, `next.config.*`, `migrations`, `CODEOWNERS`, `.env*`, `bun.lock`, `libs/core/security`. Layer 2 — keywords, from autopilot's own `skills/ai-validate/references/blocked-paths.md` § "CRITICAL: Keyword Detection", which requires inferring infrastructure impact from ticket text even when no path is named: `Dockerfile`, `Docker`, `Kubernetes`, `k8s`, `Helm`, `GitHub Actions`, `Jenkins`, `CI pipeline`, `deployment pipeline`, `OTLP`, `OpenTelemetry`, `Prometheus`, `Grafana`, `webpack config`, `turbopack config`, `deploy script`, `Napistrano`, `DeployBot`. Layer 2 is an intentional superset of the design doc, justified by autopilot rejecting these downstream anyway — catching them at triage saves a wasted run.
- `alreadyAttempted` takes the infra-only carve-out into account — see Task 3; a ticket whose sole prior attempt failed for infra reasons is still eligible.
- Each gate returns `{passed: false, gate: "<name>"}` — the gate name is what the ledger stores.

**Definition of Done:**

- [ ] A `LEGACYWEB-*` issue is rejected by the project gate before any other gate runs
- [ ] An issue whose status is `Ready to Merge`, and one with an invented status `Frobnicating`, are both rejected by the status gate
- [ ] An assigned issue and an unassigned `Spike` are each rejected with their own gate name
- [ ] A ticket referencing `.github` workflows and one referencing `bun.lock` are both rejected by the blocked-path gate (layer 1), and one whose text mentions only "GitHub Actions" with no path is rejected by layer 2
- [ ] A ticket whose only prior attempt failed with an infra-only reason is **not** rejected by the already-attempted gate
- [ ] Verify: `cd /Users/akorinek/Programming/autopilot-daily && bun test src/__tests__/gates.test.ts`

### Task 3: SQLite store

**Objective:** Implement the `bun:sqlite` store holding runs, candidates, phases and tickets. It must be writable incrementally so a run that dies during autopilot still leaves its triage ledger intact.

**Files:**

- Create: `/Users/akorinek/Programming/autopilot-daily/src/store.ts`
- Create: `/Users/akorinek/Programming/autopilot-daily/src/__tests__/store.test.ts`

**Key Decisions / Notes:**

- Four tables per the design doc. `candidates` stores `gate` (nullable) XOR `scores` JSON — a row has one or the other, never both.
- `openRun()` inserts the run row immediately and returns its id; `closeRun()` sets outcome and exit code. Stage 1 writes candidates before stage 2 starts.
- **`tickets` carries a `failureClass` column** — `null` (succeeded), `'infra'`, or `'implementation'`. This exists solely to implement the design's "already attempted, unless the prior failure was infra-only" carve-out; without it, one transient Jira or GitHub outage would permanently blacklist a ticket.
- `'infra'` means the pipeline never reached a code verdict: Jira/GitHub unreachable, auth failure, lock contention, circuit breaker, timeout before Phase 3. Anything from Phase 3 onward — implement, review, test, PR — is `'implementation'`. When unclear, classify as `'implementation'` (fail-closed: prefer not retrying a ticket over retrying a genuinely bad one).
- `alreadyAttempted(ticketKey)` returns true only when a prior attempt has `failureClass` of `null` or `'implementation'`.
- Schema created via `CREATE TABLE IF NOT EXISTS` on open. No migration framework — this is a single-user local store.
- DB path `data/store.sqlite`, gitignored. Tests use `:memory:`.

**Definition of Done:**

- [ ] Candidates written by stage 1 are readable after a run row is left open (simulating stage 2 dying)
- [ ] `alreadyAttempted(key)` is true for a ticket whose prior attempt succeeded, true for one that failed `'implementation'`, and **false** for one that failed `'infra'`
- [ ] An attempt recorded with an unrecognized or missing failure reason classifies as `'implementation'`, not `'infra'`
- [ ] Verify: `cd /Users/akorinek/Programming/autopilot-daily && bun test src/__tests__/store.test.ts`

### Task 4: Scoring prompt and first-fit selection

**Objective:** Implement the scoring stage: hand gate-surviving candidates in board-rank order to `claude -p`, which checks repo evidence in `next-pwa-app` and scores five dimensions; validate its JSON and apply first-fit selection in code so the ordering rule cannot be violated by the model.

**Files:**

- Create: `/Users/akorinek/Programming/autopilot-daily/prompts/triage-score.md`
- Create: `/Users/akorinek/Programming/autopilot-daily/src/score.ts`
- Create: `/Users/akorinek/Programming/autopilot-daily/src/__tests__/score.test.ts`

**Key Decisions / Notes:**

- **Selection lives in code, not the prompt.** The model scores each candidate independently; `score.ts` walks results in rank order and returns the first that satisfies **all three** conditions: `total >= 70`, no dimension at `0`, and `complexity !== 'high'`. A model that "recommends" a different ticket cannot override this.
- **The complexity band is a hard reject, not a tiebreak.** The Zod schema requires a `complexity: 'low' | 'medium' | 'high'` field on every scored candidate, and `'high'` is rejected regardless of total. This is the direct expression of the user's "low-to-medium complexity only" requirement; a high-complexity ticket scoring 95 is still refused.
- **Repo evidence is binary, expressed through Localization.** The design treats "not implementable in `next-pwa-app`" as a hard gate, but it needs repo I/O and so cannot live in the pure `gates.ts`. The prompt therefore MUST score Localization exactly `0` when it cannot name a confirmed file path in the repo — partial credit for a plausible-sounding but unlocated change is forbidden and must be stated in the prompt in those terms. Combined with the no-zero-dimension rule, this reproduces the hard gate's binary behaviour. This is a deliberate architecture deviation from the design doc's gate placement, not an oversight.
- Prompt runs with cwd `next-pwa-app` so it can grep the repo for the named component/route.
- Model: `sonnet`. Scoring needs judgment; haiku is too weak for the repo-evidence step.
- Validate the response with a Zod schema. On parse failure, record every candidate with verdict `score_error` and signal exit `20` — never fall through to an unscored pick.
- Cap candidates sent for scoring at 25 per board.

**Definition of Done:**

- [ ] Given fixture scores where rank 3 totals 72 and rank 1 totals 95, the pick is rank 3's ticket only if rank 1 failed a gate — otherwise rank 1 wins (first-fit, not best-fit)
- [ ] A candidate scoring 88 with Blast radius at `0` is rejected, not picked
- [ ] A candidate scoring 95 with `complexity: 'high'` and no zero dimension is rejected, not picked
- [ ] A candidate whose repo evidence is absent scores Localization `0` and is therefore rejected — verified against a fixture describing Encore backend work, which must not be picked
- [ ] A response missing the `complexity` field fails Zod validation and yields `score_error` rather than defaulting to an acceptable band
- [ ] Malformed model output produces a `score_error` result rather than a pick
- [ ] Verify: `cd /Users/akorinek/Programming/autopilot-daily && bun test src/__tests__/score.test.ts`

### Task 5: Lockfile

**Objective:** Implement the cooperative lock that keeps the long autopilot run from colliding with `babysit-prs`. Correct staleness handling is the point — a crashed run must not disable PR review permanently.

**Files:**

- Create: `/Users/akorinek/Programming/autopilot-daily/src/lock.ts`
- Create: `/Users/akorinek/Programming/autopilot-daily/src/__tests__/lock.test.ts`

**Key Decisions / Notes:**

- Path `~/.autopilot-daily.lock`, contents `{pid, startedAt}` as JSON.
- `isHeld()` returns false when the lock is older than 90 minutes (matching the job timeout) — the staleness bound is load-bearing.
- `acquire()` refuses if a fresh lock exists, returning a distinguishable result so the caller can exit cleanly rather than crash.
- Tests inject the clock and lock path; do not touch the real `$HOME`.

**Definition of Done:**

- [ ] `isHeld()` is false for a lock file with a timestamp 91 minutes old, true at 89 minutes
- [ ] `acquire()` on an existing fresh lock returns a refusal rather than overwriting it
- [ ] Verify: `cd /Users/akorinek/Programming/autopilot-daily && bun test src/__tests__/lock.test.ts`

### Task 6: Circuit breaker

**Objective:** Stop the run before triage when too many bot PRs are already open and unmerged, so a week of unreviewed AI PRs cannot accumulate silently.

**Files:**

- Create: `/Users/akorinek/Programming/autopilot-daily/src/breaker.ts`
- Create: `/Users/akorinek/Programming/autopilot-daily/src/__tests__/breaker.test.ts`

**Key Decisions / Notes:**

- The **store is authoritative** for which PRs are the bot's — query `tickets` for recorded PR numbers, then ask `gh` for their state. Do not infer ownership from the `ai/` branch prefix, which also matches hand-started autopilot runs.
- Command: `GH_HOST=github.groupondev.com gh pr view <n> --repo Mobile-Next/next-pwa-app --json state,isDraft`.
- Threshold: 3 or more open. Trips → run records a no-pick with reason `circuit_breaker` and exits `0`.
- Mock the `gh` subprocess in tests — no network, per the mock-audit rule.

**Definition of Done:**

- [ ] With 3 open PRs recorded, the breaker trips; with 2 open and 5 merged, it does not
- [ ] A `gh` invocation that fails is treated as unknown and does **not** trip the breaker, but is logged
- [ ] Verify: `cd /Users/akorinek/Programming/autopilot-daily && bun test src/__tests__/breaker.test.ts`

### Task 7: Orchestration script

**Objective:** Write `run-daily.sh`, which sequences lock → breaker → triage → autopilot → record, and maps each outcome to the correct exit code. This is where the unattended-gate assumption is first exercised against real autopilot.

**Files:**

- Create: `/Users/akorinek/Programming/autopilot-daily/scripts/run-daily.sh`
- Create: `/Users/akorinek/Programming/autopilot-daily/src/triage.ts`
- Create: `/Users/akorinek/Programming/autopilot-daily/src/__tests__/triage.test.ts`

**Key Decisions / Notes:**

- **Pool assembly is three ordered tiers, evaluated lazily and never interleaved.** `triage.ts` builds the candidate sequence as: (1) board 8872 unassigned, in rank order; (2) board 9841 unassigned, in rank order; (3) unassigned `Autopilot_AI`-labelled tickets on either board, in rank order. Tier N+1 is only consulted after every candidate in tier N has been gated _and_ scored without a pick. Concatenate the tiers into one ordered list and let first-fit walk it — do not score tiers in parallel and merge, which would let a 9841 ticket beat an unpicked 8872 one.
- Follow the `set -e` + `SCRIPT_DIR`/`PROJECT_ROOT` idiom from `ai-scheduler/scripts/start-daemon.sh`.
- `trap 'release_lock' EXIT INT TERM` — the lock must clear on every path.
- Stage 2 command, run with cwd `next-pwa-app`:
  `claude -p "/autopilot <KEY> --worktree --skip-validate" --dangerously-skip-permissions`
  with the prompt stating the run is unattended, that the Phase 2 plan gate should be approved and execution continued to Phase 3, and that `AskUserQuestion` must not be called.
- `--dry-run` stops after stage 1: ledger written, no autopilot, no Jira writes.
- Exit codes: `0` ran correctly (shipped **or** no-pick), `20` triage error, `30` autopilot failed. **Never `2`** — `ai-scheduler` reads it as `partial` and retries.
- Stage 1 retries once on a transient error before returning `20`.

**Definition of Done:**

- [ ] `bash scripts/run-daily.sh --dry-run` against the live boards writes a ledger row for every candidate considered and exits `0` without invoking autopilot
- [ ] With fixture data where board 9841 holds a passing candidate and board 8872 still holds unscored candidates, the 8872 list is exhausted first and the 9841 ticket is not picked ahead of it
- [ ] The `Autopilot_AI` overflow tier is only reached once both boards are exhausted without a pick
- [ ] A day with no eligible ticket exits `0` (not nonzero) and records a no-pick run
- [ ] Killing the script mid-run leaves no lock file behind
- [ ] Verify: `cd /Users/akorinek/Programming/autopilot-daily && bun test src/__tests__/triage.test.ts && bash scripts/run-daily.sh --dry-run; echo "exit=$?"`

### Task 8: Jira write-back and ai-scheduler integration

**Objective:** Post the claim comment and label when a ticket is taken, register the scheduled job in `ai-scheduler` (disabled), and add the lock check to `babysit-prs` so it defers while autopilot holds the machine.

**Files:**

- Modify: `/Users/akorinek/Programming/autopilot-daily/src/triage.ts`
- Modify: `/Users/akorinek/Programming/ai-scheduler/scheduler.yaml`

**Key Decisions / Notes:**

- On pick: add label `autopilot-daily` and comment `Picked up by autopilot-daily run <date>`; append the PR URL once stage 2 reports it. Skipped entirely under `--dry-run`.
- New job: `type: script`, `schedule: "30 9 * * 1-5"`, `timeout: 5400`, `max_retries: 0`, `enabled: false`, `command: bash /Users/akorinek/Programming/autopilot-daily/scripts/run-daily.sh`, `tags: [daily, autopilot]`.
- **`enabled: false` is deliberate** — the rollout calibrates on dry-runs first. Do not enable it as part of this plan.
- Prepend to the `babysit-prs` prompt: check `~/.autopilot-daily.lock`; if present and under 90 minutes old, print `Deferred — autopilot-daily holds the lock` and stop without reviewing PRs.
- ⛔ `ai-scheduler` has pre-existing uncommitted changes in `CLAUDE.md`, `cron-engine.ts`, `job-runner.ts`, `job-runner.test.ts` and `scheduler.yaml` that are **not** part of this work. Edit only the two `scheduler.yaml` regions named above; do not revert, restage or sweep in anything else.

**Definition of Done:**

- [ ] The daemon loads the new job without a Zod validation error and reports it as disabled
- [ ] `babysit-prs`'s prompt instructs the lock check as its first action, and its existing review instructions are otherwise unchanged
- [ ] Under `--dry-run`, no Jira comment or label is written
- [ ] Verify: `cd /Users/akorinek/Programming/ai-scheduler && bun test && curl -s localhost:3501/api/jobs | grep -c autopilot-daily`
