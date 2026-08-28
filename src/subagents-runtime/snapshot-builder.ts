import {
  sanitizeActivityEntry,
  sanitizeActivityTrail,
} from "./activity-sanitizer.js";
import type { ForegroundTask, PublicForegroundTask } from "./types.js";

const TEXT_LIMIT = 16_000;
const text = (value: unknown) =>
  typeof value === "string" ? value.slice(0, TEXT_LIMIT) : undefined;
const safeUsage = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value)
          .filter(
            ([, amount]) =>
              typeof amount === "number" && Number.isFinite(amount),
          )
          .slice(0, 12),
      )
    : undefined;
const safeLiveActivity = (value: ForegroundTask["liveActivity"]) =>
  value
    ? {
        trail: sanitizeActivityTrail(value.trail),
        ...(sanitizeActivityEntry(value.current)
          ? { current: sanitizeActivityEntry(value.current)! }
          : {}),
        ...(safeUsage(value.usage) ? { usage: safeUsage(value.usage)! } : {}),
      }
    : undefined;

/** Produces the only task representation permitted across the runtime/UI boundary. */
export function buildPublicTaskSnapshot(
  task: Pick<
    ForegroundTask,
    | "id"
    | "agent"
    | "task"
    | "status"
    | "createdAt"
    | "mode"
    | "startedAt"
    | "finishedAt"
    | "result"
    | "error"
    | "usage"
    | "model"
    | "effort"
    | "attempt"
    | "liveActivity"
  >,
): PublicForegroundTask {
  const {
    id,
    agent,
    status,
    createdAt,
    mode,
    startedAt,
    finishedAt,
    usage,
    model,
    effort,
    attempt,
    liveActivity,
  } = task;
  const activity = safeLiveActivity(liveActivity);
  return {
    id,
    agent,
    task: text(task.task) ?? "",
    status,
    createdAt,
    mode,
    startedAt,
    finishedAt,
    ...(text(task.result) === undefined ? {} : { result: text(task.result) }),
    ...(text(task.error) === undefined ? {} : { error: text(task.error) }),
    ...(safeUsage(usage) ? { usage: safeUsage(usage) } : {}),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(attempt === undefined ? {} : { attempt }),
    ...(activity ? { liveActivity: activity } : {}),
  };
}
