"use client";

import React, { useId, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ChevronRight } from "lucide-react";
import type {
  RunGraph,
  RunGraphAttempt,
  RunGraphCall,
  RunGraphLane,
  RunGraphSection,
  RunGraphStep,
} from "../../../shared/run-graph-types";
import { formatCostUsd } from "../../lib/cost-format";
import {
  LANE_STEP_WINDOW,
  STEP_ROW_WINDOW,
  attemptOutcome,
  callStatusDisplay,
  countLabel,
  countLaneCalls,
  countLaneErrors,
  displayPath,
  elapsedMs,
  endResultText,
  focusRevealedItem,
  formatDurationMs,
  formatOffset,
  groupCalls,
  groupStatus,
  mayOverflow,
  subagentStatusDisplay,
  sumDurations,
  windowList,
  type CallRow,
} from "../../lib/run-diagram";
import { CategoryIcon } from "./category";
import { StatusMark, TONE_MARKER, TONE_TEXT } from "./status";

// Interactive targets use a px minimum: the root font is 15px, so min-h-6 (1.5rem) is only 22.5px, under WCAG 2.2's 24px.
const toggleClass =
  "inline-flex min-h-[24px] items-center gap-1 rounded px-1 text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring";
const rowClass =
  "flex min-h-[24px] w-full min-w-0 items-center gap-2 rounded px-1 text-left text-[12px]";
const buttonRowClass = `${rowClass} hover:bg-secondary/60 focus-visible:outline-2 focus-visible:outline-ring`;
const durationClass =
  "w-12 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground";
const errorPreviewClass =
  "mt-0.5 mb-1 ml-6 whitespace-pre-wrap break-words rounded-sm bg-red-500/10 px-2 py-0.5 font-mono text-[11px] text-red-700 dark:text-red-300";

// --- Rail ---

/** Vertical line that the flow's nodes sit on. Children are positioned with `pl-6`. */
function Rail({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="relative space-y-2 before:absolute before:top-2 before:bottom-2 before:left-[7px] before:w-px before:bg-border">
      {children}
    </div>
  );
}

function Marker({ className }: { className: string }): React.ReactElement {
  return (
    <span
      aria-hidden="true"
      className={`absolute top-[5px] left-[3px] size-[9px] rounded-full ${className}`}
    />
  );
}

const hollowMarker = "border border-muted-foreground bg-card";

// --- Text ---

function ClampedText({
  text,
  lines,
  className,
}: {
  text: string;
  lines: 2 | 4;
  className?: string;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  // Whether the clamped text actually overflows, once measured in the browser.
  // Until then (server render, tests) the character-count heuristic stands in.
  const [overflows, setOverflows] = useState<boolean | null>(null);
  const textRef = useRef<HTMLParagraphElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    const element = textRef.current;
    // Expanded text is unclamped, so there is nothing to measure; the toggle stays for "Show less".
    if (!element || expanded) return;
    const measure = (): void => {
      // A hidden element (inactive tab, collapsed lane) has no box yet; the observer re-measures once shown.
      if (element.clientHeight === 0) return;
      setOverflows(element.scrollHeight > element.clientHeight + 1);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, expanded]);
  const clampable = overflows ?? mayOverflow(text, lines);
  const clamp = lines === 2 ? "line-clamp-2" : "line-clamp-4";
  return (
    <div className={className}>
      <p
        ref={textRef}
        id={id}
        className={`whitespace-pre-line break-words ${expanded ? "" : clamp}`}
      >
        {text}
      </p>
      {clampable && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((value) => !value)}
          className={toggleClass}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

function formatClock(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function Chevron({ open }: { open: boolean }): React.ReactElement {
  return (
    <ChevronRight
      aria-hidden="true"
      className={`size-3 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
    />
  );
}

// --- Call rows ---

interface FlowContext {
  /** The run is still running and this is its current attempt. */
  live: boolean;
  attemptStart: string | null;
  /** The job's working directory, for showing summaries relative to it. */
  directory: string | null;
}

function ErrorPreview({ text }: { text: string }): React.ReactElement {
  return <p className={errorPreviewClass}>{text}</p>;
}

function CallItem({
  call,
  flow,
}: {
  call: RunGraphCall;
  flow: FlowContext;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const isError = call.status === "error";
  const okPreview = !isError && call.resultPreview ? call.resultPreview : null;
  const hasDetail = Boolean(call.summary) || okPreview !== null;
  const duration = formatDurationMs(call.durationMs);
  const line = (
    <>
      <CategoryIcon
        category={call.category}
        className={isError ? `size-3.5 shrink-0 ${TONE_TEXT.error}` : undefined}
      />
      <span className="min-w-0 truncate font-medium" title={call.name}>
        {call.label}
      </span>
      {call.server && (
        <span className="min-w-0 max-w-32 truncate rounded bg-muted px-1 text-[10px] text-muted-foreground">
          {call.server}
        </span>
      )}
      <span
        className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground"
        title={call.summary || undefined}
      >
        {displayPath(call.summary, flow.directory)}
      </span>
      <StatusMark status={callStatusDisplay(call.status, flow.live)} />
      <span className={durationClass}>{duration ?? ""}</span>
    </>
  );
  return (
    <li>
      {hasDetail ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={detailId}
          onClick={() => setOpen((value) => !value)}
          className={buttonRowClass}
        >
          {line}
        </button>
      ) : (
        <div className={rowClass}>{line}</div>
      )}
      {isError && call.resultPreview && (
        <ErrorPreview text={call.resultPreview} />
      )}
      {hasDetail && (
        <div
          id={detailId}
          hidden={!open}
          className="mb-1 ml-6 space-y-0.5 text-[11px]"
        >
          {open && (
            <>
              {call.summary && (
                <p className="whitespace-pre-wrap break-all font-mono text-foreground">
                  {call.summary}
                </p>
              )}
              {okPreview && (
                <p className="whitespace-pre-wrap break-words font-mono text-muted-foreground">
                  {okPreview}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </li>
  );
}

function GroupItem({
  row,
  flow,
}: {
  row: Extract<CallRow, { kind: "group" }>;
  flow: FlowContext;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const first = row.calls[0];
  const total = formatDurationMs(sumDurations(row.calls));
  const status = groupStatus(row.calls, flow.live);
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((value) => !value)}
        className={buttonRowClass}
      >
        <CategoryIcon category={first.category} />
        <span
          className="min-w-0 truncate font-medium"
          title={first.name}
        >{`${first.label} ×${row.calls.length}`}</span>
        <Chevron open={open} />
        <span
          className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground"
          title={first.summary || undefined}
        >
          {displayPath(first.summary, flow.directory)}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">{`and ${row.calls.length - 1} more`}</span>
        <StatusMark status={status.display} count={status.pendingCount} />
        <span
          className={durationClass}
          title="Total of the known call durations"
        >
          {total ?? ""}
        </span>
      </button>
      <ul
        id={listId}
        hidden={!open}
        className="mt-px mb-1 ml-3 space-y-px border-l border-border pl-2"
      >
        {open &&
          row.calls.map((call) => (
            <CallItem key={call.id} call={call} flow={flow} />
          ))}
      </ul>
    </li>
  );
}

function SubagentItem({
  call,
  lane,
  flow,
  depth,
}: {
  call: RunGraphCall;
  lane: RunGraphLane;
  flow: FlowContext;
  depth: number;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const laneId = useId();
  const errors = countLaneErrors(lane);
  const description = lane.label || call.summary || call.label;
  const uses =
    typeof lane.toolUses === "number"
      ? countLabel(lane.toolUses, "tool use")
      : countLabel(countLaneCalls(lane), "call");
  const duration = formatDurationMs(lane.durationMs ?? call.durationMs);
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={laneId}
        onClick={() => setOpen((value) => !value)}
        className={buttonRowClass}
      >
        <CategoryIcon category={call.category} />
        <span className="min-w-0 truncate font-medium" title={description}>
          {description}
        </span>
        <Chevron open={open} />
        {lane.subagentType && (
          <span className="min-w-0 max-w-32 truncate rounded bg-muted px-1 text-[10px] text-muted-foreground">
            {lane.subagentType}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          {uses}
        </span>
        {errors > 0 && (
          <span
            className={`shrink-0 rounded bg-red-500/10 px-1 text-[11px] font-medium ${TONE_TEXT.error}`}
          >
            {countLabel(errors, "error")}
          </span>
        )}
        <StatusMark
          status={subagentStatusDisplay(lane.status, call.status, flow.live)}
        />
        <span className={durationClass}>{duration ?? ""}</span>
      </button>
      {call.status === "error" && call.resultPreview && (
        <ErrorPreview text={call.resultPreview} />
      )}
      {lane.summary && !open && (
        <p className="ml-6 line-clamp-2 break-words text-[11px] text-muted-foreground">
          {lane.summary}
        </p>
      )}
      <div
        id={laneId}
        hidden={!open}
        className="mt-1 mb-2 ml-3 rounded border border-border bg-card p-2"
      >
        {open && (
          <>
            {lane.summary && (
              <p className="mb-2 whitespace-pre-line break-words text-[11px] text-muted-foreground">
                {lane.summary}
              </p>
            )}
            {lane.steps.length > 0 ? (
              <Rail>
                <LaneSteps lane={lane} flow={flow} depth={depth + 1} />
              </Rail>
            ) : (
              <p className="text-[12px] text-muted-foreground">
                No subagent activity was captured.
              </p>
            )}
          </>
        )}
      </div>
    </li>
  );
}

function RowItem({
  row,
  flow,
  depth,
}: {
  row: CallRow;
  flow: FlowContext;
  depth: number;
}): React.ReactElement {
  if (row.kind === "group") return <GroupItem row={row} flow={flow} />;
  if (row.call.subagent)
    return (
      <SubagentItem
        call={row.call}
        lane={row.call.subagent}
        flow={flow}
        depth={depth}
      />
    );
  return <CallItem call={row.call} flow={flow} />;
}

// --- Steps ---

function StepNode({
  step,
  index,
  flow,
  depth,
}: {
  step: RunGraphStep;
  index: number;
  flow: FlowContext;
  depth: number;
}): React.ReactElement {
  const [showAllRows, setShowAllRows] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const rows = groupCalls(step.calls);
  const visible = windowList(rows.length, STEP_ROW_WINDOW, showAllRows);
  const offset = formatOffset(flow.attemptStart, step.startedAt);
  const revealRows = (): void => {
    flushSync(() => setShowAllRows(true));
    focusRevealedItem(listRef.current, visible.headEnd);
  };
  return (
    <li className="relative pl-6">
      <Marker className={hollowMarker} />
      <p className="flex items-baseline gap-2 text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground">{`Step ${index + 1}`}</span>
        {offset && <span className="font-mono tabular-nums">{offset}</span>}
      </p>
      {step.narration && (
        <ClampedText
          text={step.narration}
          lines={2}
          className="mt-0.5 text-[12px]"
        />
      )}
      {rows.length > 0 && (
        <ul ref={listRef} className="mt-0.5 space-y-px">
          {rows.slice(0, visible.headEnd).map((row) => (
            <RowItem key={row.key} row={row} flow={flow} depth={depth} />
          ))}
          {visible.hidden > 0 && (
            <li>
              <button
                type="button"
                onClick={revealRows}
                className={toggleClass}
              >{`Show ${visible.hidden} more`}</button>
            </li>
          )}
          {rows.slice(visible.tailStart).map((row) => (
            <RowItem key={row.key} row={row} flow={flow} depth={depth} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** A lane's steps, windowed so long lanes render their start and end only until asked. */
function LaneSteps({
  lane,
  flow,
  depth,
}: {
  lane: RunGraphLane;
  flow: FlowContext;
  depth: number;
}): React.ReactElement {
  const [showAll, setShowAll] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);
  const visible = windowList(lane.steps.length, LANE_STEP_WINDOW, showAll);
  const revealSteps = (): void => {
    flushSync(() => setShowAll(true));
    focusRevealedItem(listRef.current, visible.headEnd);
  };
  const node = (step: RunGraphStep, index: number): React.ReactElement => (
    <StepNode
      key={step.id}
      step={step}
      index={index}
      flow={flow}
      depth={depth}
    />
  );
  return (
    <ol
      ref={listRef}
      aria-label={depth === 0 ? "Steps" : `Steps of subagent: ${lane.label}`}
      className="space-y-2"
    >
      {lane.steps
        .slice(0, visible.headEnd)
        .map((step, offset) => node(step, offset))}
      {visible.hidden > 0 && (
        <li className="relative pl-6">
          <button
            type="button"
            onClick={revealSteps}
            className={toggleClass}
          >{`Show ${visible.hidden} more steps`}</button>
        </li>
      )}
      {lane.steps
        .slice(visible.tailStart)
        .map((step, offset) => node(step, visible.tailStart + offset))}
    </ol>
  );
}

// --- Script sections ---

function SectionList({
  sections,
}: {
  sections: RunGraphSection[];
}): React.ReactElement {
  const [showAll, setShowAll] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);
  if (sections.length === 0) {
    return (
      <p className="relative pl-6 text-[12px] text-muted-foreground">
        No &quot;=== title ===&quot; sections were found in this run&apos;s
        output.
      </p>
    );
  }
  const visible = windowList(sections.length, LANE_STEP_WINDOW, showAll);
  const revealSections = (): void => {
    flushSync(() => setShowAll(true));
    focusRevealedItem(listRef.current, visible.headEnd);
  };
  const node = (section: RunGraphSection): React.ReactElement => (
    <li key={section.id} className="relative pl-6">
      <Marker className={section.failed ? TONE_MARKER.error : hollowMarker} />
      <p className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
        <span className="min-w-0 break-words font-medium">
          {section.title || "(untitled)"}
        </span>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {countLabel(section.lineCount, "line")}
        </span>
        {section.failed && (
          <span className={`text-[11px] font-semibold ${TONE_TEXT.error}`}>
            FAILED
          </span>
        )}
        {section.issueCount > 0 && (
          <span className={`text-[11px] ${TONE_TEXT.warning}`}>
            {countLabel(section.issueCount, "issue")}
          </span>
        )}
      </p>
      {section.firstIssue && (
        <p
          className="truncate font-mono text-[11px] text-muted-foreground"
          title={section.firstIssue}
        >
          {section.firstIssue}
        </p>
      )}
    </li>
  );
  return (
    <ol ref={listRef} aria-label="Sections" className="space-y-2">
      {sections.slice(0, visible.headEnd).map(node)}
      {visible.hidden > 0 && (
        <li className="relative pl-6">
          <button
            type="button"
            onClick={revealSections}
            className={toggleClass}
          >{`Show ${visible.hidden} more sections`}</button>
        </li>
      )}
      {sections.slice(visible.tailStart).map(node)}
    </ol>
  );
}

// --- Start / End ---

function StartNode({
  attempt,
  graph,
  trigger,
}: {
  attempt: RunGraphAttempt;
  graph: RunGraph;
  trigger: string | null;
}): React.ReactElement {
  const startedAt =
    attempt.startedAt ?? (attempt.attempt <= 1 ? graph.startedAt : null);
  const clock = formatClock(startedAt);
  const how = attempt.attempt > 1 ? "retry" : trigger;
  return (
    <div className="relative pl-6">
      <Marker className="bg-muted-foreground" />
      <p className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
        <span className="font-medium">Start</span>
        {how && <span className="text-muted-foreground">{how}</span>}
        {attempt.model && (
          <span className="min-w-0 break-all font-mono text-[11px] text-muted-foreground">
            {attempt.model}
          </span>
        )}
        {clock && startedAt && (
          <time
            dateTime={startedAt}
            className="font-mono text-[11px] tabular-nums text-muted-foreground"
          >
            {clock}
          </time>
        )}
      </p>
    </div>
  );
}

function EndNode({
  attempt,
  isLast,
  graph,
  now,
}: {
  attempt: RunGraphAttempt;
  isLast: boolean;
  graph: RunGraph;
  now: number;
}): React.ReactElement {
  const label = attemptOutcome(attempt, isLast, graph.status);
  const outcome = attempt.outcome;
  const live = label.tone === "live";
  const durationMs =
    outcome?.durationMs ??
    (isLast && !live && graph.finishedAt
      ? elapsedMs(attempt.startedAt ?? graph.startedAt, graph.finishedAt, now)
      : null);
  const duration = formatDurationMs(durationMs);
  const text = endResultText(attempt, isLast);
  const facts: string[] = [];
  if (isLast && graph.exitCode !== null) facts.push(`exit ${graph.exitCode}`);
  if (outcome?.numTurns != null)
    facts.push(countLabel(outcome.numTurns, "turn"));
  if (duration) facts.push(duration);
  if (outcome?.costUsd != null) facts.push(formatCostUsd(outcome.costUsd));
  return (
    <div className="relative pl-6">
      <Marker className={TONE_MARKER[label.tone]} />
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12px]">
        <span className="font-medium">End</span>
        <span className={`font-medium ${TONE_TEXT[label.tone]}`}>
          {label.text}
        </span>
        {facts.map((fact, index) => (
          <span
            key={`${index}-${fact}`}
            className="font-mono text-[11px] tabular-nums text-muted-foreground"
          >
            {fact}
          </span>
        ))}
        {outcome && outcome.permissionDenials > 0 && (
          <span className={`text-[11px] font-medium ${TONE_TEXT.warning}`}>
            {countLabel(outcome.permissionDenials, "permission denial")}
          </span>
        )}
      </p>
      {text && (
        <ClampedText text={text} lines={4} className="mt-1 text-[12px]" />
      )}
    </div>
  );
}

// --- Attempt ---

export function AttemptFlow({
  attempt,
  isLast,
  showHeader,
  graph,
  trigger,
  directory,
  now,
}: {
  attempt: RunGraphAttempt;
  isLast: boolean;
  showHeader: boolean;
  graph: RunGraph;
  trigger: string | null;
  directory: string | null;
  now: number;
}): React.ReactElement {
  const headingId = useId();
  const outcome = attemptOutcome(attempt, isLast, graph.status);
  const flow: FlowContext = {
    live: isLast && graph.status === "running",
    attemptStart: attempt.startedAt ?? graph.startedAt,
    directory,
  };
  const lane = attempt.lane;
  let body: React.ReactNode;
  if (lane && lane.steps.length > 0) {
    body = <LaneSteps lane={lane} flow={flow} depth={0} />;
  } else if (graph.kind === "script") {
    body = <SectionList sections={attempt.sections} />;
  } else {
    body = (
      <p className="relative pl-6 text-[12px] text-muted-foreground">
        {flow.live
          ? "No tool activity yet."
          : "No tool activity was recorded for this run."}
      </p>
    );
  }
  return (
    <section
      aria-labelledby={showHeader ? headingId : undefined}
      aria-label={showHeader ? undefined : "Run flow"}
    >
      {showHeader && (
        <h3
          id={headingId}
          className="mb-2 flex flex-wrap items-baseline gap-x-2 text-[12px] font-semibold"
        >
          <span>{`Attempt ${attempt.attempt}`}</span>
          <span className={`font-normal ${TONE_TEXT[outcome.tone]}`}>
            {outcome.text}
          </span>
        </h3>
      )}
      <Rail>
        <StartNode attempt={attempt} graph={graph} trigger={trigger} />
        {body}
        {attempt.truncated && (
          <p className="relative pl-6 text-[11px] text-muted-foreground">
            Trace limit reached; later activity in this attempt was not
            recorded.
          </p>
        )}
        <EndNode attempt={attempt} isLast={isLast} graph={graph} now={now} />
      </Rail>
    </section>
  );
}
