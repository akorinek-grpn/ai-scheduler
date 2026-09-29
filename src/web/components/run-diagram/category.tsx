import React from "react";
import {
  Bot,
  FilePen,
  FileText,
  Globe,
  ListChecks,
  Plug,
  Search,
  Sparkles,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { ToolCategory } from "../../../shared/run-graph-types";
import type { CategoryShare } from "../../lib/run-diagram";

interface CategoryMeta {
  label: string;
  icon: LucideIcon;
  /**
   * Bar/legend swatch. Hues are spread evenly and skip red (reserved for errors);
   * lightness is tuned for >= 3:1 against the card surface in both themes.
   */
  swatch: string;
}

export const CATEGORY_META: Record<ToolCategory, CategoryMeta> = {
  read: {
    label: "Read",
    icon: FileText,
    swatch: "bg-[oklch(0.58_0.13_235)] dark:bg-[oklch(0.72_0.12_235)]",
  },
  search: {
    label: "Search",
    icon: Search,
    swatch: "bg-[oklch(0.58_0.14_272)] dark:bg-[oklch(0.72_0.13_272)]",
  },
  edit: {
    label: "Edit",
    icon: FilePen,
    swatch: "bg-[oklch(0.58_0.13_161)] dark:bg-[oklch(0.72_0.13_161)]",
  },
  shell: {
    label: "Shell",
    icon: SquareTerminal,
    swatch: "bg-[oklch(0.60_0.14_50)] dark:bg-[oklch(0.72_0.13_50)]",
  },
  web: {
    label: "Web",
    icon: Globe,
    swatch: "bg-[oklch(0.58_0.11_198)] dark:bg-[oklch(0.72_0.11_198)]",
  },
  agent: {
    label: "Agent",
    icon: Bot,
    swatch: "bg-[oklch(0.56_0.15_309)] dark:bg-[oklch(0.72_0.13_309)]",
  },
  skill: {
    label: "Skill",
    icon: Sparkles,
    swatch: "bg-[oklch(0.58_0.15_346)] dark:bg-[oklch(0.72_0.13_346)]",
  },
  mcp: {
    label: "MCP",
    icon: Plug,
    swatch: "bg-[oklch(0.58_0.13_124)] dark:bg-[oklch(0.74_0.13_124)]",
  },
  plan: {
    label: "Plan",
    icon: ListChecks,
    swatch: "bg-[oklch(0.60_0.10_87)] dark:bg-[oklch(0.76_0.11_87)]",
  },
  other: {
    label: "Other",
    icon: Wrench,
    swatch: "bg-[oklch(0.58_0_0)] dark:bg-[oklch(0.68_0_0)]",
  },
};

export function categoryMeta(category: ToolCategory): CategoryMeta {
  return CATEGORY_META[category] ?? CATEGORY_META.other;
}

export function CategoryIcon({
  category,
  className,
}: {
  category: ToolCategory;
  className?: string;
}): React.ReactElement {
  const Icon = categoryMeta(category).icon;
  return (
    <Icon
      aria-hidden="true"
      className={className ?? "size-3.5 shrink-0 text-muted-foreground"}
    />
  );
}

/** Proportional bar of tool calls per category, with a legend that carries icon, name and count. */
export function CategoryBreakdown({
  shares,
}: {
  shares: CategoryShare[];
}): React.ReactElement | null {
  if (shares.length === 0) return null;
  const description = `Tool calls by category: ${shares.map((share) => `${categoryMeta(share.category).label} ${share.count}`).join(", ")}`;
  return (
    <div className="space-y-1.5">
      <div
        role="img"
        aria-label={description}
        className="flex h-1.5 w-full gap-px overflow-hidden rounded-full"
      >
        {shares.map((share) => (
          <span
            key={share.category}
            className={`h-full min-w-[2px] ${categoryMeta(share.category).swatch}`}
            style={{ width: `${share.percent}%` }}
          />
        ))}
      </div>
      <ul
        aria-hidden="true"
        className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground"
      >
        {shares.map((share) => (
          <li key={share.category} className="inline-flex items-center gap-1">
            <span
              className={`size-2 shrink-0 rounded-[2px] ${categoryMeta(share.category).swatch}`}
            />
            <CategoryIcon
              category={share.category}
              className="size-3 shrink-0"
            />
            <span>{categoryMeta(share.category).label}</span>
            <span className="font-mono tabular-nums text-foreground">
              {share.count}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
