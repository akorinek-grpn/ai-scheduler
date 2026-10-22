#!/usr/bin/env python3
"""Sample the Claude account's usage window (the figures Claude Code's /usage shows).

Writes data/usage/latest.json (the newest sample, with the raw response) and appends one line
to data/usage/headroom.jsonl (without the raw body). The dashboard's "Claude usage window" card
reads them through GET /api/usage (2026-10-16).

Pace (2026-10-22, after the Air's account spent its week in 60 h): every sample carries a `pace`
derived from the 7-day window - the allowance left per remaining hour against the nominal
100 points / 168 h, as a factor clamped to 0.25-2.0: on budget 1.0, running hot below 1, budget
to spare above 1, and at most 0.5 while the 5-hour window is 85% used or more. The pr-review
skill's batch-preflight.sh multiplies its scheduled rate_limit by that factor (lib/pace-budget.jq),
so a hot week reviews fewer PRs per round and a quiet one more. No 7-day figure, no reset time,
a reset outside the next 168 h, or an unavailable sample is `unknown` at 1.0: the budget stays.

The token is Claude Code's OAuth access token from the login keychain item
"Claude Code-credentials" (claudeAiOauth.accessToken). It is used for the one request and never
printed, logged or written. The keychain is readable from the GUI session (launchd), not from
an ssh session, so the job runs under the scheduler's LaunchAgent.

The response shape is not documented: the parser takes every top-level object that carries a
utilization figure or a reset time as one window (five_hour, seven_day, seven_day_opus, ...)
and keeps the raw body beside it; `parsed` says whether anything known was found. Any failure
(no token, HTTP error, bad JSON) is a sample with status "unavailable" and exit 0: the job is a
gauge, not a check.

Usage:
  usage-headroom.py [--out DIR] [--endpoint URL] [--from-file PATH] [--host NAME] [--timeout S]
                    [--now ISO]
    --from-file reads the response from a file instead of the network (tests, replays).
    --now fixes the clock the pace is computed against (tests, replays).
"""
from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_ENDPOINT = "https://api.anthropic.com/api/oauth/usage"
KEYCHAIN_SERVICE = "Claude Code-credentials"
WINDOW_LABELS = {
    "five_hour": "5-hour",
    "seven_day": "7-day",
    "seven_day_opus": "7-day Opus",
    "seven_day_sonnet": "7-day Sonnet",
    "seven_day_oauth_apps": "7-day apps",
}
UTILIZATION_KEYS = ("utilization", "utilization_percent", "used_percent", "percent", "usage", "used")
RESET_KEYS = ("resets_at", "reset_at", "resets", "reset", "resets_in")
LEDGER_MAX_LINES = 4000  # about 80 days at two samples an hour

# Pace: the 7-day window spent evenly is NOMINAL_RATE points an hour. The factor is bounded so a
# bad sample can neither stop the rounds nor flood them; PACE_BAND is how far from the expected
# line "on pace" reaches. The 5-hour brake caps the factor while that window is nearly used,
# whatever the week says (it hit 98% on 2026-10-16 while the week stood at 21%).
WINDOW_HOURS = 168.0
NOMINAL_RATE = 100.0 / WINDOW_HOURS
FACTOR_MIN, FACTOR_MAX = 0.25, 2.0
PACE_BAND = 10.0
FIVE_HOUR_BRAKE_PERCENT = 85.0
FIVE_HOUR_BRAKE_FACTOR = 0.5


def now_iso(now: datetime | None = None) -> str:
    return (now or datetime.now(timezone.utc)).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_iso(value: object) -> datetime | None:
    """An ISO 8601 time as an aware UTC datetime, or None (a `Z` suffix is accepted)."""
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def compute_pace(windows: dict, now: datetime) -> dict:
    """The review-budget factor for this sample: allowance left per remaining hour of the 7-day
    window over the nominal rate, clamped, with the 5-hour brake. Unknown is 1.0."""
    pace: dict = {
        "state": "unknown",
        "factor": 1.0,
        "utilization": None,
        "expected": None,
        "hours_left": None,
        "five_hour_brake": False,
        "note": "",
    }
    week = windows.get("seven_day") or {}
    used = week.get("utilization_percent")
    resets = parse_iso(week.get("resets_at"))
    if used is None or resets is None:
        pace["note"] = "no 7-day utilization or reset time in the sample; budget unchanged"
        return pace
    hours_left = (resets - now).total_seconds() / 3600.0
    if hours_left <= 0 or hours_left > WINDOW_HOURS:
        pace["note"] = "7-day reset %s is not within the next %d h of %s; budget unchanged" % (
            week.get("resets_at"), int(WINDOW_HOURS), now_iso(now))
        return pace
    expected = (WINDOW_HOURS - hours_left) / WINDOW_HOURS * 100.0
    remaining = max(0.0, 100.0 - used)
    factor = (remaining / max(hours_left, 1.0)) / NOMINAL_RATE
    if used > expected + PACE_BAND:
        state = "hot"
    elif used < expected - PACE_BAND:
        state = "spare"
    else:
        state = "on-pace"
    five = (windows.get("five_hour") or {}).get("utilization_percent")
    brake = five is not None and five >= FIVE_HOUR_BRAKE_PERCENT
    if brake:
        factor = min(factor, FIVE_HOUR_BRAKE_FACTOR)
    factor = min(FACTOR_MAX, max(FACTOR_MIN, round(factor, 2)))
    note = "%.0f%% used, %.0f%% expected at this point of the week; %.0f points left for %.0f h: %.2fx the nominal rate" % (
        used, expected, remaining, hours_left, factor)
    if brake:
        note += "; 5-hour window at %.0f%%, braking" % five
    pace.update(
        state=state,
        factor=factor,
        utilization=round(used, 1),
        expected=round(expected, 1),
        hours_left=round(hours_left, 1),
        five_hour_brake=brake,
        note=note,
    )
    return pace


def local_host_name() -> str:
    try:
        out = subprocess.run(
            ["scutil", "--get", "LocalHostName"], capture_output=True, text=True, timeout=5, check=False
        )
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        pass
    return socket.gethostname().split(".")[0]


def read_token() -> str | None:
    """The OAuth access token from the login keychain, or None. Never printed."""
    try:
        out = subprocess.run(
            ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0 or not out.stdout.strip():
        return None
    try:
        creds = json.loads(out.stdout.strip())
    except json.JSONDecodeError:
        return None
    token = (creds.get("claudeAiOauth") or {}).get("accessToken") if isinstance(creds, dict) else None
    return token if isinstance(token, str) and token else None


def fetch(endpoint: str, token: str, timeout: float) -> tuple[int | None, str | None, str | None]:
    """(http status, body, error). The token goes into the request header only."""
    req = urllib.request.Request(
        endpoint,
        headers={
            "Authorization": "Bearer " + token,
            "anthropic-beta": "oauth-2025-04-20",
            "Accept": "application/json",
            "User-Agent": "ai-scheduler usage-headroom",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - fixed https endpoint
            return resp.status, resp.read().decode("utf-8", "replace"), None
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", "replace") if err.fp else ""
        return err.code, body, "HTTP %d" % err.code
    except (urllib.error.URLError, OSError, ValueError) as err:
        return None, None, str(err)


def _number(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.rstrip("%"))
        except ValueError:
            return None
    return None


def parse_usage(raw: object) -> tuple[dict, bool]:
    """Every top-level object with a utilization figure or a reset time, as a window."""
    windows: dict = {}
    if not isinstance(raw, dict):
        return windows, False
    for key, value in raw.items():
        if not isinstance(value, dict):
            continue
        utilization = None
        for k in UTILIZATION_KEYS:
            if k in value:
                utilization = _number(value[k])
                if utilization is not None:
                    break
        resets_at = None
        for k in RESET_KEYS:
            if isinstance(value.get(k), str) and value[k]:
                resets_at = value[k]
                break
        if utilization is None and resets_at is None:
            continue
        percent = None
        assumed_fraction = False
        if utilization is not None:
            if 0 <= utilization <= 1.0:
                # A 0-1 figure is read as a fraction; a sample above 1 settles it as percent.
                percent = utilization * 100
                assumed_fraction = True
            else:
                percent = utilization
        windows[key] = {
            "label": WINDOW_LABELS.get(key, key.replace("_", " ")),
            "utilization_percent": percent,
            "assumed_fraction": assumed_fraction,
            "resets_at": resets_at,
            "raw": value,
        }
    return windows, bool(windows)


def write_sample(out_dir: Path, record: dict) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    latest = out_dir / "latest.json"
    tmp = latest.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")
    os.replace(tmp, latest)
    line = {k: v for k, v in record.items() if k != "raw"}
    ledger = out_dir / "headroom.jsonl"
    with ledger.open("a") as handle:
        handle.write(json.dumps(line, sort_keys=True) + "\n")
    # Keep the ledger bounded; the run history and latest.json carry everything recent.
    try:
        lines = ledger.read_text().splitlines()
        if len(lines) > LEDGER_MAX_LINES:
            ledger.write_text("\n".join(lines[-LEDGER_MAX_LINES:]) + "\n")
    except OSError:
        pass


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    default_out = Path(__file__).resolve().parent.parent / "data" / "usage"
    parser.add_argument("--out", default=str(default_out), help="directory for latest.json and headroom.jsonl")
    parser.add_argument("--endpoint", default=os.environ.get("USAGE_ENDPOINT", DEFAULT_ENDPOINT))
    parser.add_argument("--from-file", help="read the response body from this file instead of the network")
    parser.add_argument("--host", default=None, help="host name recorded in the sample (default: LocalHostName)")
    parser.add_argument("--timeout", type=float, default=20.0)
    parser.add_argument("--now", default=None, help="ISO time the pace is computed against (default: the clock)")
    args = parser.parse_args(argv)
    now = datetime.now(timezone.utc)
    if args.now:
        fixed = parse_iso(args.now)
        if fixed is None:
            parser.error("--now needs an ISO 8601 time, got %r" % args.now)
        now = fixed

    record: dict = {
        "version": 1,
        "at": now_iso(now),
        "host": args.host or local_host_name(),
        "endpoint": None if args.from_file else args.endpoint,
        "source": "file" if args.from_file else "network",
        "status": "unavailable",
        "http": None,
        "parsed": False,
        "windows": {},
        "raw": None,
        "error": None,
    }

    body: str | None = None
    if args.from_file:
        try:
            body = Path(args.from_file).read_text()
            record["http"] = 200
        except OSError as err:
            record["error"] = "read %s: %s" % (args.from_file, err)
    else:
        token = read_token()
        if token is None:
            record["error"] = "no OAuth token in the login keychain (%s); run under the GUI session" % KEYCHAIN_SERVICE
        else:
            status, body, error = fetch(args.endpoint, token, args.timeout)
            record["http"] = status
            if error:
                record["error"] = error
                if status is not None and body:
                    record["raw"] = body[:2000]
                body = None

    if body is not None:
        try:
            raw = json.loads(body)
        except json.JSONDecodeError as err:
            record["error"] = "response is not JSON: %s" % err
            record["raw"] = body[:2000]
        else:
            windows, parsed = parse_usage(raw)
            record["status"] = "ok"
            record["parsed"] = parsed
            record["windows"] = windows
            record["raw"] = raw

    record["pace"] = compute_pace(record["windows"], now)
    write_sample(Path(args.out), record)

    if record["status"] == "ok":
        summary = ", ".join(
            "%s %s%s" % (
                w["label"],
                "%.0f%%" % w["utilization_percent"] if w["utilization_percent"] is not None else "?",
                " resets %s" % w["resets_at"] if w["resets_at"] else "",
            )
            for w in record["windows"].values()
        )
        pace = record["pace"]
        print("usage-headroom: ok (%s | pace %s x%.2f)" % (
            summary or "no known window in the response; raw kept", pace["state"], pace["factor"]))
    else:
        print("usage-headroom: unavailable (%s)" % record["error"])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
