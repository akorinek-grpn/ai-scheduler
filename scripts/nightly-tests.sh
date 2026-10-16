#!/usr/bin/env bash
# nightly-tests.sh - one run of every test suite the scheduled jobs depend on (2026-10-15).
# Nothing else runs them between edits: these repos have no CI, and a pr-review test script
# failed unnoticed from 2026-10-01 to 10-15. Runs on the Air (the `nightly-tests` job), so the
# MacBook Pro's CPU stays free. Exits 1 when any suite fails, so the evaluator flags the run.
#
# Suites: every pr-review scripts/test-*.sh plus test-openai-review.py, ai-scheduler's vitest
# suite, autopilot-daily's bun suite. A missing checkout or runner counts as a failure.
set -uo pipefail
SKILL="$HOME/.claude/skills/pr-review/scripts"
SCHED="$HOME/Programming/ai-scheduler"
AUTO="$HOME/Programming/autopilot-daily"
BUN=$(command -v bun || echo "$HOME/.bun/bin/bun")
FAILED=(); SUMMARY=()

show_failure() { # label, output
  echo "---- $1 FAILED, last 30 lines:"
  printf '%s\n' "$2" | tail -30
}

# pr-review: one script at a time, so a failure names its script.
if [ -d "$SKILL" ]; then
  n=0; bad=0
  for t in "$SKILL"/test-*.sh "$SKILL"/test-openai-review.py; do
    [ -f "$t" ] || continue
    n=$((n + 1))
    case "$t" in *.py) out=$(cd "$SKILL" && python3 "$t" 2>&1 < /dev/null) ;; *) out=$(cd "$SKILL" && bash "$t" 2>&1 < /dev/null) ;; esac
    rc=$?
    if [ $rc -ne 0 ]; then bad=$((bad + 1)); FAILED+=("pr-review/$(basename "$t")"); show_failure "pr-review/$(basename "$t") (exit $rc)" "$out"; fi
  done
  SUMMARY+=("pr-review: $((n - bad))/$n scripts pass")
else
  FAILED+=("pr-review (no checkout at $SKILL)")
fi

# ai-scheduler: vitest, single run. The job runs at background priority on the Air's efficiency
# cores beside the PR sessions: the first run (2026-10-15) took a 0.2 s simulation test past
# vitest's 5 s limit. Two workers and a 60 s limit still catch a real hang; NO_COLOR keeps the
# summary line parseable.
if [ -d "$SCHED/node_modules" ]; then
  out=$(cd "$SCHED" && NO_COLOR=1 FORCE_COLOR=0 npx vitest run --maxWorkers=2 --testTimeout=60000 2>&1); rc=$?
  tests=$(printf '%s\n' "$out" | grep -E '^\s+Tests ' | tail -1 | sed -E 's/^\s+Tests\s+//')
  SUMMARY+=("ai-scheduler: ${tests:-no test summary}")
  [ $rc -eq 0 ] || { FAILED+=("ai-scheduler"); show_failure "ai-scheduler (exit $rc)" "$out"; }
else
  FAILED+=("ai-scheduler (no node_modules in $SCHED)")
fi

# autopilot-daily: bun test.
if [ -d "$AUTO" ] && [ -x "$BUN" ]; then
  out=$(cd "$AUTO" && "$BUN" test 2>&1); rc=$?
  tests=$(printf '%s\n' "$out" | grep -E '^Ran [0-9]+ tests' | tail -1)
  SUMMARY+=("autopilot-daily: ${tests:-no test summary}, $(printf '%s\n' "$out" | grep -cE '^\(fail\)') failing")
  [ $rc -eq 0 ] || { FAILED+=("autopilot-daily"); show_failure "autopilot-daily (exit $rc)" "$out"; }
else
  FAILED+=("autopilot-daily (no checkout or no bun at $BUN)")
fi

# b2c-toolkit: the clone the flow runs from stays at origin/main on both Macs (Adam, 2026-10-15,
# after the two clones had drifted 31 commits apart unnoticed). This only reports; the pull is
# `deploy-air.sh toolkit` on the MacBook Pro.
TK="$HOME/Programming/b2c-toolkit"
if [ -d "$TK/.git" ]; then
  if git -C "$TK" fetch -q origin main 2>/dev/null; then
    behind=$(git -C "$TK" rev-list --count HEAD..origin/main 2>/dev/null || echo "?")
    SUMMARY+=("b2c-toolkit: $(git -C "$TK" rev-parse --short HEAD), behind origin/main by $behind")
    [ "$behind" = 0 ] || FAILED+=("b2c-toolkit ($behind commit(s) behind origin/main; run deploy-air.sh toolkit on the MacBook Pro)")
  else
    SUMMARY+=("b2c-toolkit: fetch failed, version not checked")
  fi
else
  FAILED+=("b2c-toolkit (no clone at $TK)")
fi

echo
printf '%s\n' "${SUMMARY[@]}"
if [ ${#FAILED[@]} -eq 0 ]; then
  echo "NIGHTLY_TESTS: all green"
  exit 0
fi
echo "NIGHTLY_TESTS: FAILED - ${FAILED[*]}"
exit 1
