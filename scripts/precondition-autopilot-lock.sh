#!/usr/bin/env bash
# Precondition for the review-round jobs (babysit-prs, approve-prs, answer-pr-comments):
# defer while a live autopilot-daily run or babysit session holds the machine.
#
# Until 2026-10-16 each job's prompt asked the model to run lock-status.sh and stop if it said
# HELD, which cost a Sonnet session per hour just to print one line. As a `precondition:` the
# check runs before any session starts: exit 75 records the run as `deferred` and the daemon
# retries the slot in retry_after (10 min, twice); exit 0 lets the job run.
#
# Prints lock-status.sh's one line; exits 75 on HELD, 0 on FREE, 1 when the script is missing
# (the run fails visibly rather than reviewing while the autopilot may be working).
set -uo pipefail
LOCK_STATUS="${AUTOPILOT_LOCK_STATUS:-$HOME/Programming/autopilot-daily/scripts/lock-status.sh}"
[ -f "$LOCK_STATUS" ] || { echo "precondition: $LOCK_STATUS not found" >&2; exit 1; }
line=$(bash "$LOCK_STATUS")
echo "autopilot lock: $line"
case "$line" in
  HELD*) exit 75 ;;
  *) exit 0 ;;
esac
