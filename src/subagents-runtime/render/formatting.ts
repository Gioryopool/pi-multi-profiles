// Independently adapted from pi-subagents-j0k3r (MIT); see THIRD_PARTY_NOTICES.md.
import {
  sanitizeActivityEntry,
  sanitizeActivityTrail,
} from "../activity-sanitizer.js";

const clean = (value: unknown, fallback: string) =>
  typeof value === "string" && value.trim() ? value.trim() : fallback;
export type RenderTask = {
  id: string;
  agent: string;
  task: string;
  status: string;
  mode: string;
  attempt: number;
  model?: unknown;
  effort: string;
  usage?: any;
  result?: string;
  error?: string;
  lastActivity?: string;
  liveActivity?: {
    trail?: Array<{ label: string; kind: "semantic" | "fallback" }>;
    current?: { label: string; kind: "semantic" | "fallback" };
  };
  backgroundable?: boolean;
  backgroundShortcut?: string;
};
const safeLiveActivity = (
  value: unknown,
): RenderTask["liveActivity"] | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const activity = value as Record<string, unknown>;
  const current = sanitizeActivityEntry(activity.current);
  return {
    trail: sanitizeActivityTrail(activity.trail),
    ...(current ? { current } : {}),
  };
};
export function publicTask(value: any): RenderTask | undefined {
  if (!value || typeof value !== "object" || !clean(value.id, ""))
    return undefined;
  return {
    id: clean(value.id, ""),
    agent: clean(value.agent, "subagent"),
    task: typeof value.task === "string" ? value.task : "",
    status: clean(value.status, "unknown"),
    mode: clean(value.mode, "task"),
    attempt: typeof value.attempt === "number" ? value.attempt : 1,
    model: value.model,
    effort: clean(value.effort, "default/current"),
    usage: value.usage,
    result: typeof value.result === "string" ? value.result : undefined,
    error: typeof value.error === "string" ? value.error : undefined,
    lastActivity:
      typeof value.lastActivity === "string" ? value.lastActivity : undefined,
    liveActivity: safeLiveActivity(value.liveActivity),
    backgroundable: value.backgroundable,
    backgroundShortcut: value.backgroundShortcut,
  };
}
/** Supports actual direct tool details plus Joker-compatible task/results/tasks containers. */
export function taskFromDetails(result: any): RenderTask | undefined {
  const details = result?.details ?? result;
  const nestedTask =
    details?.task && typeof details.task === "object"
      ? details.task
      : undefined;
  const value = Array.isArray(details)
    ? details[0]
    : (nestedTask ?? details?.results?.[0] ?? details?.tasks?.[0] ?? details);
  return publicTask(value);
}
export function tasksFromDetails(result: any): RenderTask[] {
  const details = result?.details ?? result;
  const values = Array.isArray(details)
    ? details
    : (details?.tasks ?? details?.results ?? []);
  return Array.isArray(values)
    ? values.map(publicTask).filter((task): task is RenderTask => Boolean(task))
    : [];
}
export function modelLabel(model: any) {
  return model &&
    typeof model.provider === "string" &&
    typeof model.id === "string"
    ? `${model.provider}/${model.id}`
    : "default/current";
}
function tokens(value: number) {
  return value < 1000
    ? String(value)
    : value < 10_000
      ? `${(value / 1000).toFixed(1)}k`
      : value < 1_000_000
        ? `${Math.round(value / 1000)}k`
        : `${(value / 1_000_000).toFixed(1)}M`;
}
export function formatUsage(usage: any) {
  if (!usage || typeof usage !== "object") return "";
  const parts: string[] = [];
  if (usage.turns)
    parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
  if (usage.input) parts.push(`↑${tokens(usage.input)}`);
  if (usage.output) parts.push(`↓${tokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${tokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${tokens(usage.cacheWrite)}`);
  if (typeof usage.cost === "number") parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens) parts.push(`ctx:${tokens(usage.contextTokens)}`);
  return parts.join(" ");
}
export function failed(task: RenderTask | undefined, result: any) {
  return Boolean(
    result?.isError ||
      ["failed", "cancelled", "interrupted"].includes(task?.status ?? ""),
  );
}
export function collapsedResultHint(
  task: RenderTask | undefined,
  error: boolean,
  resultTool: string,
) {
  return `${error ? "error" : "response"}: collapsed · ctrl+o to expand${task ? ` · ${resultTool} ${task.id}` : ""}`;
}
