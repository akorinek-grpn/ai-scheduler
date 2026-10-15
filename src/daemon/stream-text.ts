/**
 * Readable text for a run's log from one Claude stream-json line: assistant text, one line
 * per tool call, clipped tool results, the final result. Shared by claude jobs (job-runner)
 * and the inner sessions of script runs (inner-sessions), whose transcripts use the same
 * message shapes.
 */

function formatToolInput(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Bash":
      return input.command ? `$ ${input.command}` : "";
    case "Read":
      return input.file_path ? `Reading ${input.file_path}` : "";
    case "Write":
      return input.file_path ? `Writing ${input.file_path}` : "";
    case "Edit":
      return input.file_path ? `Editing ${input.file_path}` : "";
    case "Glob":
      return input.pattern ? `Glob: ${input.pattern}` : "";
    case "Grep":
      return input.pattern ? `Grep: ${input.pattern}` : "";
    case "Skill":
      return input.skill ? `Skill: ${input.skill}` : "";
    case "Agent":
      return input.description ? `Agent: ${input.description}` : "";
    default:
      return "";
  }
}

function truncate(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return (
    lines.slice(0, maxLines).join("\n") +
    `\n... (${lines.length - maxLines} more lines)`
  );
}

export function extractTextFromStreamJson(line: string): string | null {
  try {
    const event = JSON.parse(line);

    // Assistant message — extract text AND tool calls
    if (event.type === "assistant" && event.message?.content) {
      const parts: string[] = [];

      for (const block of event.message.content) {
        if (block.type === "text" && block.text?.trim()) {
          parts.push(block.text);
        }
        if (block.type === "tool_use") {
          const detail = formatToolInput(block.name, block.input ?? {});
          if (detail) {
            parts.push(`\n> [${block.name}] ${detail}\n`);
          } else {
            parts.push(`\n> [${block.name}]\n`);
          }
        }
      }

      if (parts.length > 0) return parts.join("");
    }

    // Content block delta (streaming partial text)
    if (event.type === "content_block_delta" && event.delta?.text) {
      return event.delta.text;
    }

    // Tool result — nested inside "user" message events
    if (event.type === "user" && event.message?.content) {
      const contents = Array.isArray(event.message.content)
        ? event.message.content
        : [event.message.content];

      const parts: string[] = [];
      for (const block of contents) {
        if (block.type === "tool_result") {
          let text = "";
          if (typeof block.content === "string") {
            text = block.content;
          } else if (Array.isArray(block.content)) {
            text = block.content
              .filter((b: { type: string }) => b.type === "text")
              .map((b: { text: string }) => b.text)
              .join("");
          }
          if (text.trim()) {
            parts.push(truncate(text, 50));
          }
        }
      }
      if (parts.length > 0) return parts.join("\n") + "\n";
    }

    // Final result
    if (event.type === "result" && event.result?.trim()) {
      return event.result;
    }
  } catch {
    // Not valid JSON — could be partial line, ignore
  }
  return null;
}
