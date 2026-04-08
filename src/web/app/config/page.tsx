import fs from "fs";
import path from "path";

const CONFIG_PATH = path.join(process.cwd(), "scheduler.yaml");

export default function ConfigPage(): React.ReactElement {
  let content = "";
  let lastModified = "";

  try {
    content = fs.readFileSync(CONFIG_PATH, "utf-8");
    const stat = fs.statSync(CONFIG_PATH);
    lastModified = stat.mtime.toLocaleString();
  } catch {
    content = "# Config file not found";
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Config</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Read-only view of scheduler.yaml · Last modified: {lastModified}
        </p>
      </div>

      <div className="rounded-md border border-border bg-zinc-950 p-6">
        <pre className="font-mono text-sm text-zinc-300 whitespace-pre-wrap leading-relaxed">
          {content}
        </pre>
      </div>

      <p className="text-xs text-muted-foreground">
        To edit, use the <code className="bg-zinc-800 px-1 py-0.5 rounded">/ai-scheduler</code> skill in Claude Code.
      </p>
    </div>
  );
}
