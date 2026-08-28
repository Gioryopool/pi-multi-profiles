import { ACTIVITY_LIMIT, fallbackActivity, sanitizeSemanticHeading } from "./activity-sanitizer.js";
import type { LiveActivity } from "./types.js";

const label = (value: unknown) => typeof value === "string" && value.trim() ? value.trim().replace(/[\r\n\t]+/g, " ").slice(0, 120) : undefined;
const usage = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).filter(([, amount]) => typeof amount === "number" && Number.isFinite(amount)).slice(0, 12);
  return entries.length ? Object.fromEntries(entries) : undefined;
};
const appendUnique = (trail: LiveActivity["trail"], next: LiveActivity["trail"][number]) => [...trail.filter((entry) => entry.label !== next.label), next].slice(-ACTIVITY_LIMIT);

function semanticHeading(message: Record<string, unknown> | undefined) {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return undefined;
  const thinking = message.content
    .filter((part): part is Record<string, unknown> => Boolean(part) && typeof part === "object" && ((part as Record<string, unknown>).type === "thinking" || (part as Record<string, unknown>).type === "reasoning"))
    .map((part) => part.thinking ?? part.reasoning)
    .filter((content: unknown): content is string => typeof content === "string");
  const headings = thinking.flatMap((content) => content.split("\n")).map((line) => line.match(/^\*\*([^*\r\n]+)\*\*$/)?.[1]?.trim()).filter((heading): heading is string => Boolean(heading));
  for (let index = headings.length - 1; index >= 0; index--) {
    const heading = sanitizeSemanticHeading(headings[index]);
    if (heading) return heading;
  }
  return undefined;
}

/** Bounded model-authored heading summaries and generic fallback activity for nested events. */
export function createLiveActivityState(): LiveActivity { return { trail: [] }; }
export function processSubagentEvent(previous: LiveActivity, event: unknown): LiveActivity {
  const value = event && typeof event === "object" ? event as Record<string, unknown> : {};
  const message = value.message && typeof value.message === "object" ? value.message as Record<string, unknown> : undefined;
  const toolValue = value.tool && typeof value.tool === "object" ? value.tool as Record<string, unknown> : undefined;
  const type = label(value.type);
  const tool = label(value.toolName ?? value.tool_name ?? toolValue?.name);
  const heading = type === "message_update" ? semanticHeading(message) : undefined;
  const activity = heading ? { label: heading, kind: "semantic" as const } : fallbackActivity(tool) ?? (type === "message_start" && message?.role === "assistant" ? { label: "Thinking", kind: "fallback" as const } : undefined);
  const complete = Boolean(type && /(?:_end|_complete|_completed|_finish|_finished)$/.test(type));
  const start = Boolean(activity && (type === "tool_call" || (type === "message_start" && message?.role === "assistant") || /(?:_start|_begin)$/.test(type ?? "")));
  let trail = previous.trail.slice(-ACTIVITY_LIMIT);
  let current = previous.current;
  if (complete && activity) {
    trail = appendUnique(trail, current ?? activity);
    current = undefined;
  } else if (activity && (start || type === "message_update")) {
    if (current && current.label !== activity.label) trail = appendUnique(trail, current);
    current = activity;
  }
  const nextUsage = usage(value.usage ?? message?.usage);
  return { trail, ...(current ? { current } : {}), ...(nextUsage ? { usage: nextUsage } : previous.usage ? { usage: previous.usage } : {}) };
}
