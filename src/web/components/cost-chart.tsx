"use client";

import React from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { CostDayBucket, HostCostStats } from "../../shared/cost-types";
import { useHostView } from "./host-view";
import {
  costCoverageLabel,
  formatCostDate,
  formatCostUsd,
  formatDecisionCostUsd,
  totalsCoverage,
} from "../lib/cost-format";
import { CostValue } from "./cost-value";

export function CostChart({
  daily,
  hosts,
}: {
  daily: CostDayBucket[];
  /** Per-host shares on a multi-host setup: the bars stack one segment per host. */
  hosts?: HostCostStats[];
}): React.ReactElement {
  const { colorOf } = useHostView();
  const split = hosts && hosts.length > 1 ? hosts : null;
  const data = split
    ? daily.map((day, index) => ({
        ...day,
        ...Object.fromEntries(split.map((h, i) => [`h${i}`, h.daily[index]?.totalCostUsd ?? null])),
      }))
    : daily;
  const hasReportedCosts = daily.some((day) => day.totalCostUsd !== null);
  return (
    <div className="min-w-0 space-y-2">
      <h3 className="text-sm font-medium">Daily reported cost · UTC</h3>
      {split && (
        <ul className="flex flex-wrap gap-x-6 gap-y-1 text-[12px]" aria-label="Reported cost by Mac">
          {split.map((h) => (
            <li key={h.name} className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: colorOf(h.name) }} aria-hidden="true" />
              <span className="font-medium">{h.role}</span>
              <span className="font-mono tabular-nums text-muted-foreground">
                {formatCostUsd(h.period.totalCostUsd)} · {h.period.runs} runs
              </span>
            </li>
          ))}
        </ul>
      )}
      {hasReportedCosts ? (
        <div
          role="group"
          aria-label="Daily reported cost chart in USD; exact values and coverage in the following table"
          className="h-64 min-w-0"
        >
          <ResponsiveContainer
            width="100%"
            height="100%"
            minWidth={0}
            initialDimension={{ width: 320, height: 256 }}
          >
            <BarChart
              data={data}
              accessibilityLayer
              margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
            >
              <CartesianGrid vertical={false} stroke="var(--color-border)" />
              <XAxis
                dataKey="date"
                tickFormatter={formatCostDate}
                minTickGap={28}
                tick={{ fontSize: 12, fill: "var(--color-muted-foreground)" }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tickFormatter={(value: number) => formatCostUsd(value)}
                tick={{ fontSize: 12, fill: "var(--color-muted-foreground)" }}
                width={72}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                itemStyle={{ color: "var(--color-foreground)" }}
                filterNull={false}
                isAnimationActive={false}
                formatter={(value, name) => {
                  const index = typeof name === "string" && /^h\d+$/.test(name) ? Number(name.slice(1)) : -1;
                  return [
                    formatCostUsd(typeof value === "number" ? value : null),
                    index >= 0 && split ? `${split[index].role} · reported USD` : "Reported USD",
                  ];
                }}
                labelFormatter={(label) => {
                  const day = daily.find((bucket) => bucket.date === label);
                  return day
                    ? `${day.date} UTC · ${costCoverageLabel(day)}${totalsCoverage(day) === "partial" ? " · partial total" : ""}`
                    : String(label);
                }}
                contentStyle={{
                  backgroundColor: "var(--color-card)",
                  color: "var(--color-foreground)",
                  border: "1px solid var(--color-border)",
                  borderRadius: "var(--radius)",
                  fontSize: 13,
                  maxWidth: 300,
                  whiteSpace: "normal",
                }}
                cursor={{ fill: "var(--color-secondary)" }}
              />
              {split ? (
                split.map((h, i) => (
                  <Bar
                    key={h.name}
                    dataKey={`h${i}`}
                    stackId="hosts"
                    fill={colorOf(h.name)}
                    stroke="var(--color-card)"
                    strokeWidth={2}
                    radius={i === split.length - 1 ? [2, 2, 0, 0] : [0, 0, 0, 0]}
                    isAnimationActive={false}
                  />
                ))
              ) : (
                <Bar
                  dataKey="totalCostUsd"
                  fill="var(--color-chart-1)"
                  radius={[2, 2, 0, 0]}
                  isAnimationActive={false}
                />
              )}
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="py-6 text-sm text-muted-foreground">
          No reported costs in this period. Unavailable costs are not zero.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Bars show reported amounts only; missing reports are not zero. See daily
        coverage for partial totals.
      </p>
      <details>
        <summary className="min-h-9 cursor-pointer rounded py-1 text-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">
          Daily values and coverage
        </summary>
        <div
          className="max-h-80 overflow-auto rounded focus-visible:outline-2 focus-visible:outline-ring"
          tabIndex={0}
          role="region"
          aria-label="Daily cost values and reporting coverage"
        >
          <table className="w-full text-left text-sm">
            <caption className="sr-only">
              Daily USD estimates for retained and pruned runs, UTC dates
            </caption>
            <thead className="text-muted-foreground">
              <tr>
                {[
                  "Date (UTC)",
                  "Reported USD",
                  "Execution",
                  "Evaluation",
                  "Jev spend",
                  "Coverage",
                ].map((label) => (
                  <th
                    scope="col"
                    key={label}
                    className="whitespace-nowrap py-2 pr-4 font-medium"
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {daily.map((day) => (
                <tr key={day.date} className="border-t border-border/50">
                  <th
                    scope="row"
                    className="whitespace-nowrap py-2 pr-4 font-normal"
                  >
                    {day.date}
                  </th>
                  <td className="py-2 pr-4">
                    <CostValue
                      value={day.totalCostUsd}
                      coverage={totalsCoverage(day)}
                    />
                  </td>
                  <td className="py-2 pr-4 font-mono tabular-nums">
                    {formatCostUsd(day.executionCostUsd)}
                  </td>
                  <td className="py-2 pr-4 font-mono tabular-nums">
                    {formatCostUsd(day.evaluationCostUsd)}
                  </td>
                  <td className="py-2 pr-4 font-mono tabular-nums">
                    {day.decisionRequests
                      ? `${day.decisionRequests} · ${formatDecisionCostUsd(day.decisionCostUsd)}`
                      : "none"}
                  </td>
                  <td className="py-2 text-muted-foreground">
                    {costCoverageLabel(day)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
