# Lifetime Activity Dashboard Section — Design

**Status:** Approved 2026-04-20

## Goal

Add a "Lifetime Activity" section to the main dashboard showing aggregate
totals (AI sessions, tool calls) and a 30-day time-series visualization of
Claude-based runs and the tools they invoked.

## Motivation

The existing dashboard only shows a 7-day activity chart of *all* runs. The
user wants visibility into two specific things:

1. How many Claude sessions we've triggered (distinct from shell-script jobs).
2. How many tool calls those sessions performed — a signal of AI workload.

## Data

All inputs already exist or can be derived:

| Need               | Source                                                    |
| ------------------ | --------------------------------------------------------- |
| Tool call count    | `tool_use` blocks in Claude stream-json (runtime capture) |
| Tool calls (old)   | Count `^> \[` markers in existing `output.log` files      |
| Tool names         | `block.name` at runtime / regex from `> [Name]` markers   |
| Session type       | `meta.jobConfig.type === "claude"`                        |
| Timestamp          | `meta.startedAt` (ISO string)                             |

## Storage

Add a new per-run file: `data/runs/<job-id>/<run-id>/stats.json`:

```json
{
  "toolCalls": 42,
  "toolsByName": { "Bash": 12, "Read": 18, "Edit": 8, "Grep": 4 },
  "isAiSession": true
}
```

- Script jobs → `toolCalls: 0`, `toolsByName: {}`, `isAiSession: false`.
- Written by `job-runner` after the child process closes.
- For existing runs without a `stats.json`, the daemon backfills lazily on
  first read by parsing `output.log` and counting `^> \[Name]` markers.

## API

New endpoint on the daemon (port 3501):

```
GET /api/stats/activity?days=30
```

Response shape:

```json
{
  "lifetime": {
    "sessions": 1284,
    "toolCalls": 17329,
    "toolsByName": { "Bash": 5400, "Read": 4200, ... }
  },
  "daily": [
    { "date": "2026-03-22", "sessions": 12, "toolCalls": 180 },
    ...
  ]
}
```

Aggregation happens in the daemon. Clients never receive raw per-run data
via this endpoint.

The web layer adds `src/web/app/api/stats/activity/route.ts` as a thin proxy
to the daemon (following the pattern of existing proxy routes).

## UI

New component `LifetimeActivity`, placed between `StatsCards` and
`DashboardCharts` on the main dashboard page. Three subcomponents:

1. **Totals row** — three big numbers: AI sessions, total tool calls, average
   tool calls per session. Same visual grammar as the existing `StatsCards`.
2. **30-day time-series** — `recharts ComposedChart`: bars for sessions (left
   axis), line for tool calls (right axis).
3. **Top tools bar** — horizontal stacked bar of the top 5 tools by call
   share, with percentages.

The component polls the `/api/stats/activity` endpoint on the same 5s cadence
as the rest of the dashboard.

## Out of Scope

- No separate `/stats` page.
- No job-level or tag-level filtering.
- No token or cost tracking.
- No configurable time window (30 days is hard-coded).

All of these can be added later if the feature proves useful.

## File Summary

```
CREATE src/web/components/lifetime-activity.tsx
CREATE src/web/app/api/stats/activity/route.ts
CREATE src/daemon/__tests__/stats.test.ts
CREATE src/daemon/stats.ts                     # aggregation + backfill helpers
MODIFY src/shared/types.ts                     # add RunStats
MODIFY src/shared/paths.ts                     # add getStatsPath
MODIFY src/daemon/job-runner.ts                # count tool_use, write stats.json
MODIFY src/daemon/api.ts                       # mount /api/stats/activity
MODIFY src/web/lib/api-client.ts               # add getActivityStats
MODIFY src/web/app/page.tsx                    # render <LifetimeActivity />
```
