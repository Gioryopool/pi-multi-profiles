// Independently adapted from pi-subagents-j0k3r (MIT); see THIRD_PARTY_NOTICES.md.
import {
  sanitizeActivityEntry,
  sanitizeActivityTrail,
} from "../activity-sanitizer.js";
import type { LiveActivityEntry } from "../types.js";
import { formatUsage, modelLabel, type RenderTask } from "./formatting.js";

const ACTIVITY_LIMIT = 3;

function compactActivity(task: RenderTask): string[] {
  const current = sanitizeActivityEntry(task.liveActivity?.current);
  const activities = [
    ...sanitizeActivityTrail(task.liveActivity?.trail),
    ...(current ? [current] : []),
  ].reduce<LiveActivityEntry[]>(
    (unique, entry) => [
      ...unique.filter((current) => current.label !== entry.label),
      entry,
    ],
    [],
  );
  const semantic = activities
    .filter((entry) => entry.kind === "semantic")
    .slice(-ACTIVITY_LIMIT);
  const visible = semantic.length
    ? semantic
    : activities
        .filter((entry) => entry.kind === "fallback")
        .slice(-ACTIVITY_LIMIT);
  if (!visible.length) return ["↳ Working"];
  return visible.map((entry) =>
    entry.label === current?.label
      ? `\u001b[1;36m↳ ${entry.label}\u001b[0m`
      : `\u001b[2m↳ ${entry.label}\u001b[0m`,
  );
}

export function progressText(task: RenderTask | undefined, frame = 0) {
  const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"][
    frame % 10
  ]!;
  if (!task) return `${spinner} Starting subagent…`;
  const usage = formatUsage(task.usage);
  return [
    `${spinner} agent: ${task.agent} · status: ${task.status} · attempt: ${task.attempt} · effort: ${task.effort}`,
    `↳ model: ${modelLabel(task.model)}${usage ? ` · usage: ${usage}` : ""}`,
    ...compactActivity(task),
    task.backgroundable
      ? `↳ ${task.backgroundShortcut ?? "ctrl+h"} to send to background`
      : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}
