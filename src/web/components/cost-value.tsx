import React from "react";
import Link from "next/link";
import type { CostTotals, RunCostSummary } from "../../shared/cost-types";
import { COST_DISCLAIMER, costCoverageLabel, formatCostUsd, totalsCoverage } from "../lib/cost-format";
import { ModelLabels } from "./model-labels";

interface CostValueProps {
  value: number | null | undefined;
  coverage?: RunCostSummary["coverage"];
}

export function CostValue({ value, coverage }: CostValueProps): React.ReactElement {
  const amount = formatCostUsd(value);
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5" title={value == null ? "No cost report available" : `${value} USD reported estimate; not a subscription invoice`}>
      <span className="font-mono tabular-nums">{amount}</span>
      {amount !== "Unavailable" && coverage && (
        <span className="text-[11px] text-muted-foreground">
          {coverage === "partial" ? "partial" : coverage === "complete" ? "reported" : "coverage unavailable"}
        </span>
      )}
    </span>
  );
}

export function JobCost({ jobId, cost, configuredModel }: { jobId: string; cost?: CostTotals; configuredModel?: string }): React.ReactElement {
  return (
    <Link
      href={`/runs?job=${encodeURIComponent(jobId)}`}
      className="block min-h-6 rounded py-1 text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
      title={COST_DISCLAIMER}
    >
      <span className="flex flex-wrap items-baseline gap-x-2">
        <span>Retained USD estimate</span>
        <CostValue value={cost?.totalCostUsd} coverage={totalsCoverage(cost)} />
      </span>
      <span className="block">{costCoverageLabel(cost)}</span>
      <ModelLabels models={cost?.executionModels} configuredModel={configuredModel} />
    </Link>
  );
}
