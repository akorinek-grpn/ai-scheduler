import React from "react";
import { getExecutionModels, getReportedModels } from "../../shared/model-usage";
import { ModelLabels } from "./model-labels";
import type { CostEntry, RunCostSummary, TokenUsage } from "../../shared/cost-types";
import { COST_DISCLAIMER, formatCostUsd } from "../lib/cost-format";
import { CostValue } from "./cost-value";

function ReportedTokens({ tokens }: { tokens: TokenUsage | null }): React.ReactElement {
  if (!tokens) return <p className="text-[12px] text-muted-foreground">Reported tokens unavailable</p>;
  return (
    <dl className="flex flex-wrap gap-x-5 gap-y-2 text-[12px]">
      {([
        ["Input", tokens.inputTokens], ["Output", tokens.outputTokens],
        ["Cache read", tokens.cacheReadTokens], ["Cache write", tokens.cacheWriteTokens],
      ] as const).map(([label, value]) => (
        <div key={label}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="font-mono tabular-nums">{value.toLocaleString("en-US")}</dd>
        </div>
      ))}
    </dl>
  );
}

function EntryDetails({ entry }: { entry: CostEntry }): React.ReactElement {
  return (
    <div className="space-y-2 rounded border border-border/50 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-[13px]">
        <div className="min-w-0 break-words">
          <span className="font-medium">{entry.label}</span>
          <span className="ml-2 text-[11px] text-muted-foreground">{entry.source === "script" ? "script task" : "Claude report"}</span>
        </div>
        <CostValue value={entry.costUsd} />
      </div>
      <p className="break-all font-mono text-[11px] text-muted-foreground">{entry.id}</p>
      {entry.model && <ModelLabels models={[entry.model]} />}
      <ReportedTokens tokens={entry.tokens} />
      {entry.models.length > 0 ? (
        <div className="overflow-x-auto rounded focus-visible:outline-2 focus-visible:outline-ring" tabIndex={0} role="region" aria-label={`Reported model costs for ${entry.label}`}>
          <table className="w-full text-left text-[12px]">
            <caption className="pb-2 text-left text-muted-foreground">Reported model breakdown · already included in the report total</caption>
            <thead className="text-muted-foreground">
              <tr>
                {["Model", "Input", "Output", "Cache read", "Cache write", "USD estimate"].map((label) => <th scope="col" key={label} className="whitespace-nowrap py-1 pr-4 font-medium">{label}</th>)}
              </tr>
            </thead>
            <tbody>
              {entry.models.map((model, index) => (
                <tr key={`${model.model}-${index}`} className="border-t border-border/50">
                  <th scope="row" className="max-w-64 break-words py-2 pr-4 font-normal">{model.model}</th>
                  {[model.inputTokens, model.outputTokens, model.cacheReadTokens, model.cacheWriteTokens].map((value, column) => <td key={column} className="py-2 pr-4 font-mono tabular-nums">{value.toLocaleString("en-US")}</td>)}
                  <td className="whitespace-nowrap py-2 font-mono tabular-nums">{formatCostUsd(model.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="text-[11px] text-muted-foreground">Model breakdown unavailable.</p>}
    </div>
  );
}

export function RunCostDetails({ cost, configuredModel }: { cost?: RunCostSummary; configuredModel?: string }): React.ReactElement {
  const executionComplete = cost ? cost.attempts.length > 0 && cost.attempts.every((attempt) => attempt.complete) : false;
  return (
    <section aria-labelledby="run-cost-heading" className="mb-4 space-y-3 rounded border border-border bg-card p-4">
      <h2 id="run-cost-heading" className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">Reported run cost</h2>
      <p className="text-[12px] leading-relaxed text-muted-foreground">{COST_DISCLAIMER}</p>
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <dt className="text-[12px] text-muted-foreground">Total USD estimate</dt>
          <dd className="mt-1 text-lg"><CostValue value={cost?.totalCostUsd} coverage={cost?.coverage ?? "unavailable"} /></dd>
        </div>
        <div>
          <dt className="text-[12px] text-muted-foreground">Execution · all attempts</dt>
          <dd className="mt-1 text-lg"><CostValue value={cost?.executionCostUsd} coverage={executionComplete ? "complete" : "partial"} /></dd>
        </div>
        <div>
          <dt className="text-[12px] text-muted-foreground">Evaluation {cost?.evaluationState === "pending" && "· Pending"}</dt>
          <dd className="mt-1 text-lg"><CostValue value={cost?.evaluationCostUsd} /></dd>
        </div>
      </dl>
      <div className="space-y-1">
        <ModelLabels label="Execution models" models={getExecutionModels(cost)} configuredModel={configuredModel} />
        <ModelLabels label="Evaluation models" models={getReportedModels(cost?.evaluation ? [cost.evaluation] : [])} />
      </div>
      <p className="text-[12px] text-muted-foreground">
        {cost?.coverage === "partial" ? "Partial total: only reported costs are included. Missing execution or evaluation costs are not zero." : cost?.coverage === "complete" ? "Complete reporting for this run." : "Cost reporting unavailable for this run."}
        {" "}Historical runs and scripts without cost reporting remain unavailable.
      </p>
      <div className="border-t border-border/50 pt-3">
        <h3 className="mb-2 text-[12px] font-medium">Reported tokens</h3>
        <ReportedTokens tokens={cost?.tokens ?? null} />
        <p className="mt-2 text-[11px] text-muted-foreground">Token coverage depends on the reporter; main-loop-only usage may omit subagents.</p>
      </div>
      <details className="border-t border-border/50 pt-2">
        <summary className="min-h-8 cursor-pointer rounded py-1 text-[12px] font-medium focus-visible:outline-2 focus-visible:outline-ring">Attempts, tasks and models</summary>
        <div className="mt-3 space-y-4">
          {cost?.attempts.length ? cost.attempts.map((attempt) => (
            <section key={attempt.attempt} className="space-y-2">
              <h3 className="flex flex-wrap items-baseline justify-between gap-2 text-[12px] font-medium">
                <span>Attempt {attempt.attempt} · {attempt.complete ? "complete reporting" : "partial reporting"}</span>
                <CostValue value={attempt.entries.length ? attempt.entries.reduce((sum, entry) => sum + entry.costUsd, 0) : null} coverage={attempt.complete ? "complete" : "partial"} />
              </h3>
              {attempt.entries.length ? attempt.entries.map((entry) => <EntryDetails key={entry.id} entry={entry} />) : <p className="text-[12px] text-muted-foreground">Cost and token reports unavailable for this attempt.</p>}
            </section>
          )) : <p className="text-[12px] text-muted-foreground">No execution reports available.</p>}
          <section className="space-y-2">
            <h3 className="text-[12px] font-medium">Evaluation report</h3>
            {cost?.evaluation ? <EntryDetails entry={cost.evaluation} /> : <p className="text-[12px] text-muted-foreground">{cost?.evaluationState === "pending" ? "Pending evaluation cost report." : "Evaluation reporting unavailable."}</p>}
          </section>
        </div>
      </details>
    </section>
  );
}
