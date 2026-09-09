import React from "react";

interface ModelLabelsProps {
  models?: string[];
  configuredModel?: string;
  label?: string;
}

export function ModelLabels({ models = [], configuredModel, label = "Reported models" }: ModelLabelsProps): React.ReactElement {
  const names = models.length > 0 ? models : configuredModel ? [configuredModel] : [];
  const configuredOnly = models.length === 0 && Boolean(configuredModel);
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-1 text-[11px] text-muted-foreground">
      {names.length ? (
        <>
          <span>{configuredOnly ? "Configured model" : label}:</span>
          {names.map((model) => (
            <span key={model} className="min-w-0 max-w-full rounded bg-secondary px-1.5 py-0.5 font-mono text-foreground [overflow-wrap:anywhere]" title={configuredOnly ? "Run model usage has not been reported; this is configuration only." : "Model ID from reported usage; other unreported models may be missing."}>
              {model}
            </span>
          ))}
        </>
      ) : <span>{label === "Reported models" ? "Models" : label} unavailable</span>}
    </span>
  );
}
