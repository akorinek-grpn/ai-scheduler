"use client";

import { useEffect, useState, useMemo } from "react";
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { getActivityStats, type ActivityStatsResponse } from "@/lib/api-client";

const CHART_HEIGHT = 160;
const TOP_TOOL_COUNT = 5;

function formatDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function topTools(toolsByName: Record<string, number>, totalCalls: number): Array<{ name: string; count: number; pct: number }> {
  const entries = Object.entries(toolsByName)
    .map(([name, count]) => ({ name, count, pct: totalCalls ? (count / totalCalls) * 100 : 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_TOOL_COUNT);
  return entries;
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

export function LifetimeActivity(): React.ReactElement {
  const [data, setData] = useState<ActivityStatsResponse | null>(null);

  useEffect(() => {
    const load = (): void => {
      getActivityStats(30).then(setData).catch(() => {/* noop */});
    };
    load();
    const interval = setInterval(load, 5_000);
    return () => clearInterval(interval);
  }, []);

  const { sessions, toolCalls, avg, chartData, tools } = useMemo(() => {
    if (!data) {
      return { sessions: 0, toolCalls: 0, avg: 0, chartData: [], tools: [] as Array<{ name: string; count: number; pct: number }> };
    }
    const sessions = data.lifetime.sessions;
    const toolCalls = data.lifetime.toolCalls;
    const avg = sessions === 0 ? 0 : Math.round(toolCalls / sessions);
    const chartData = data.daily.map((d) => ({
      label: formatDate(d.date),
      sessions: d.sessions,
      toolCalls: d.toolCalls,
    }));
    return { sessions, toolCalls, avg, chartData, tools: topTools(data.lifetime.toolsByName, toolCalls) };
  }, [data]);

  return (
    <section className="rounded border border-border p-4 space-y-4" aria-label="Lifetime activity">
      <div className="flex items-center justify-between">
        <h3 className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
          Lifetime Activity
        </h3>
        <span className="text-[11px] text-muted-foreground">Last 30 days trend · totals since start</span>
      </div>

      {/* Totals */}
      <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2">
        <div>
          <div className="text-2xl font-mono font-semibold tabular-nums">{formatNumber(sessions)}</div>
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">AI sessions</div>
        </div>
        <div>
          <div className="text-2xl font-mono font-semibold tabular-nums">{formatNumber(toolCalls)}</div>
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Tool calls</div>
        </div>
        <div>
          <div className="text-2xl font-mono font-semibold tabular-nums">{formatNumber(avg)}</div>
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Avg tools / session</div>
        </div>
      </div>

      {/* Time-series */}
      {chartData.length > 0 && (
        <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
          <ComposedChart data={chartData} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--color-border)" strokeOpacity={0.3} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
              axisLine={false}
              tickLine={false}
              interval={Math.floor(chartData.length / 8)}
            />
            <YAxis
              yAxisId="sessions"
              tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
              axisLine={false}
              tickLine={false}
              width={24}
              allowDecimals={false}
            />
            <YAxis
              yAxisId="tools"
              orientation="right"
              tick={{ fontSize: 10, fill: "var(--color-muted-foreground)" }}
              axisLine={false}
              tickLine={false}
              width={32}
              allowDecimals={false}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "var(--color-card)",
                border: "1px solid var(--color-border)",
                borderRadius: "var(--radius)",
                fontSize: 12,
                color: "var(--color-foreground)",
              }}
              cursor={{ fill: "var(--color-secondary)", opacity: 0.4 }}
            />
            <Bar yAxisId="sessions" dataKey="sessions" fill="oklch(0.70 0.15 250)" radius={[2, 2, 0, 0]} />
            <Line
              yAxisId="tools"
              type="monotone"
              dataKey="toolCalls"
              stroke="oklch(0.70 0.18 150)"
              strokeWidth={2}
              dot={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      )}

      {/* Top tools */}
      {tools.length > 0 && (
        <div className="space-y-1">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Top tools</div>
          <div className="flex items-center gap-1 text-[11px]">
            {tools.map((t, i) => (
              <div
                key={t.name}
                className="flex items-center gap-1 px-2 py-1 rounded bg-secondary/40"
                title={`${t.name}: ${formatNumber(t.count)} calls (${t.pct.toFixed(1)}%)`}
              >
                <span className="font-medium">{t.name}</span>
                <span className="tabular-nums text-muted-foreground">{t.pct.toFixed(0)}%</span>
                {i < tools.length - 1 && <span className="text-border ml-1">·</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {sessions === 0 && (
        <p className="text-[13px] text-muted-foreground text-center py-4">
          No AI sessions recorded yet.
        </p>
      )}
    </section>
  );
}
