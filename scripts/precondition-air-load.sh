#!/usr/bin/env bash
# Precondition for the autopilot jobs (autopilot-daily, autopilot-babysit): the flow is phased so
# it never overflows the Air (Adam, 2026-10-15; "if it's busy and there is a risk of crashing,
# don't run the autopilot", 2026-10-16). Defers (exit 75) when
#   - another autopilot run or babysit session holds the lock (lock-status.sh says HELD),
#   - the machine is short of memory (`memory_pressure -Q` free percentage below the floor),
#   - the kernel reports memory pressure (`kern.memorystatus_vm_pressure_level` 2 = warn,
#     4 = critical; the signal that precedes jetsam kills and swap storms),
#   - swap in use is above the cap (`vm.swapusage`),
#   - the 5-minute load average is above AUTOPILOT_MAX_LOAD_PER_CORE x logical cores (sustained
#     saturation; on 2026-10-16 the 8-core M3 Air sat at 1.8-2.0 per core during a review round
#     with Chrome open, and an implementation session adds its builds and tests on top of that),
#   - macOS reports CPU throttling (`pmset -g therm` CPU_Speed_Limit below the floor, when it
#     reports one at all; Apple Silicon prints nothing until a thermal event is recorded), or
#   - a build or test from another job is still running (vitest, jest, nx, next build, tsc, bun test).
# Exits 0 when the Air is free. Every check prints what it saw, so a deferred run's log says why.
#
# Knobs (env): AUTOPILOT_MIN_FREE_MEMORY_PCT (20), AUTOPILOT_MAX_LOAD_PER_CORE (2.0),
# AUTOPILOT_MAX_SWAP_MB (4096), AUTOPILOT_MIN_CPU_SPEED_PCT (70), AUTOPILOT_LOCK_STATUS (the lock
# script); AUTOPILOT_SKIP_LOAD_CHECK=1 keeps only the lock check (tests, other OSes).
set -uo pipefail
LOCK_STATUS="${AUTOPILOT_LOCK_STATUS:-$HOME/Programming/autopilot-daily/scripts/lock-status.sh}"
MIN_FREE="${AUTOPILOT_MIN_FREE_MEMORY_PCT:-20}"
MAX_LOAD_PER_CORE="${AUTOPILOT_MAX_LOAD_PER_CORE:-2.0}"
MAX_SWAP_MB="${AUTOPILOT_MAX_SWAP_MB:-4096}"
MIN_CPU_SPEED="${AUTOPILOT_MIN_CPU_SPEED_PCT:-70}"

if [ -f "$LOCK_STATUS" ]; then
  line=$(bash "$LOCK_STATUS")
  echo "autopilot lock: $line"
  case "$line" in HELD*) exit 75 ;; esac
else
  echo "autopilot lock: $LOCK_STATUS not found (lock not checked)"
fi

[ "${AUTOPILOT_SKIP_LOAD_CHECK:-0}" = 1 ] && exit 0

if command -v memory_pressure >/dev/null 2>&1; then
  free_pct=$(memory_pressure -Q 2>/dev/null | sed -n 's/.*free percentage: *\([0-9]*\)%.*/\1/p' | head -1)
  if [ -n "$free_pct" ]; then
    echo "memory: ${free_pct}% free (floor ${MIN_FREE}%)"
    [ "$free_pct" -lt "$MIN_FREE" ] && exit 75
  else
    echo "memory: memory_pressure gave no free percentage (not checked)"
  fi
fi

if command -v sysctl >/dev/null 2>&1; then
  # Kernel memory pressure level: 1 normal, 2 warn, 4 critical (absent on other OSes).
  level=$(sysctl -n kern.memorystatus_vm_pressure_level 2>/dev/null | tr -dc '0-9')
  if [ -n "$level" ]; then
    case "$level" in
      1) echo "memory pressure: normal" ;;
      *) echo "memory pressure: level $level (warn is 2, critical 4)"; exit 75 ;;
    esac
  fi

  # Swap in use, from `vm.swapusage` ("total = 2048.00M  used = 517.38M  free = ...").
  swap_used=$(sysctl -n vm.swapusage 2>/dev/null | sed -n 's/.*used = *\([0-9.]*\)\([MG]\).*/\1 \2/p' | head -1)
  if [ -n "$swap_used" ]; then
    swap_mb=$(echo "$swap_used" | awk '{ v = $1; if ($2 == "G") v = v * 1024; printf "%d", v }')
    echo "swap: ${swap_mb} MB used (cap ${MAX_SWAP_MB} MB)"
    [ "$swap_mb" -gt "$MAX_SWAP_MB" ] && exit 75
  fi

  # Sustained load: the 5-minute average against the logical core count.
  load5=$(sysctl -n vm.loadavg 2>/dev/null | awk '{ print $3 }')
  cores=$(sysctl -n hw.logicalcpu 2>/dev/null | tr -dc '0-9')
  if [ -n "$load5" ] && [ -n "$cores" ] && [ "$cores" -gt 0 ]; then
    over=$(awk -v l="$load5" -v c="$cores" -v m="$MAX_LOAD_PER_CORE" 'BEGIN { printf "%d", (l > c * m) ? 1 : 0 }')
    per_core=$(awk -v l="$load5" -v c="$cores" 'BEGIN { printf "%.2f", l / c }')
    echo "load: 5-min average ${load5} on ${cores} cores = ${per_core} per core (cap ${MAX_LOAD_PER_CORE})"
    [ "$over" = 1 ] && exit 75
  fi
fi

if command -v pmset >/dev/null 2>&1; then
  # Only present once macOS has recorded a thermal event; silence means no throttling known.
  speed=$(pmset -g therm 2>/dev/null | sed -n 's/.*CPU_Speed_Limit *= *\([0-9]*\).*/\1/p' | head -1)
  if [ -n "$speed" ]; then
    echo "thermal: CPU speed limit ${speed}% (floor ${MIN_CPU_SPEED}%)"
    [ "$speed" -lt "$MIN_CPU_SPEED" ] && exit 75
  else
    echo "thermal: no throttling recorded"
  fi
fi

# Builds and tests another job may still be running. Our own process tree is not running yet
# (the precondition comes first), so any match belongs to someone else.
busy=$(pgrep -fl -E '(^|/)(vitest|jest)( |$)|nx (affected|run|test)|next build|(^|/)tsc( |$)|bun test|npm (run )?test' 2>/dev/null | grep -v -E 'precondition-air-load|pgrep' | head -5)
if [ -n "$busy" ]; then
  echo "build/test still running:"
  echo "$busy" | sed 's/^/  /'
  exit 75
fi
echo "load: no build or test running"
exit 0
