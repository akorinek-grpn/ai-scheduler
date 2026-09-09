"use client";

import React from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { CostDayBucket } from "../../shared/cost-types";
import { costCoverageLabel, formatCostDate, formatCostUsd, totalsCoverage } from "../lib/cost-format";
import { CostValue } from "./cost-value";

export function CostChart({ daily }: { daily: CostDayBucket[] }): React.ReactElement {
  const hasReportedCosts = daily.some((day) => day.totalCostUsd !== null);
  return (
    <div className="min-w-0 space-y-2">
      <h3 className="text-[12px] font-medium">Daily reported cost · UTC</h3>
      {hasReportedCosts ? (
        <div role="group" aria-label="Daily reported cost chart in USD; exact values and coverage in the following table" className="h-48 min-w-0">
          <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 320, height: 192 }}>
            <BarChart data={daily} accessibilityLayer margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--color-border)" />
              <XAxis dataKey="date" tickFormatter={formatCostDate} minTickGap={24} tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={(value: number) => formatCostUsd(value)} tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }} width={66} axisLine={false} tickLine={false} />
              <Tooltip
                filterNull={false}
                isAnimationActive={false}
                formatter={(value) => [formatCostUsd(typeof value === "number" ? value : null), "Reported USD"]}
                labelFormatter={(label) => {
                  const day = daily.find((bucket) => bucket.date === label);
                  return day ? `${day.date} UTC · ${costCoverageLabel(day)}${totalsCoverage(day) === "partial" ? " · partial total" : ""}` : String(label);
                }}
                contentStyle={{ backgroundColor: "var(--color-card)", color: "var(--color-foreground)", border: "1px solid var(--color-border)", borderRadius: "var(--radius)", fontSize: 12, maxWidth: 280, whiteSpace: "normal" }}
                cursor={{ fill: "var(--color-secondary)" }}
              />
              <Bar dataKey="totalCostUsd" fill="var(--color-chart-1)" radius={[2, 2, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : <p className="py-6 text-[12px] text-muted-foreground">No reported costs in this period. Unavailable costs are not zero.</p>}
      <p className="text-[11px] text-muted-foreground">Bars show reported amounts only; missing reports are not zero. See daily coverage for partial totals.</p>
      <details>
        <summary className="min-h-8 cursor-pointer rounded py-1 text-[12px] text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">Daily values and coverage</summary>
        <div className="max-h-72 overflow-auto rounded focus-visible:outline-2 focus-visible:outline-ring" tabIndex={0} role="region" aria-label="Daily cost values and reporting coverage">
          <table className="w-full text-left text-[12px]">
            <caption className="sr-only">Daily USD estimates for retained runs, UTC dates</caption>
            <thead className="text-muted-foreground"><tr>{["Date (UTC)", "Reported USD", "Execution", "Evaluation", "Coverage"].map((label) => <th scope="col" key={label} className="whitespace-nowrap py-2 pr-4 font-medium">{label}</th>)}</tr></thead>
            <tbody>
              {daily.map((day) => (
                <tr key={day.date} className="border-t border-border/50">
                  <th scope="row" className="whitespace-nowrap py-2 pr-4 font-normal">{day.date}</th>
                  <td className="py-2 pr-4"><CostValue value={day.totalCostUsd} coverage={totalsCoverage(day)} /></td>
                  <td className="py-2 pr-4 font-mono tabular-nums">{formatCostUsd(day.executionCostUsd)}</td>
                  <td className="py-2 pr-4 font-mono tabular-nums">{formatCostUsd(day.evaluationCostUsd)}</td>
                  <td className="py-2 text-muted-foreground">{costCoverageLabel(day)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
