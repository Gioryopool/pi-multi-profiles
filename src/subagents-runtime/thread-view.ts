import type { ForegroundTask } from "./types.js";

export type ThreadEntry = {
  role: "user" | "assistant" | "tool" | "thinking" | "custom";
  text: string;
  name?: string;
  toolCallId?: string;
};
type ThreadFrame = {
  role: "user" | "assistant";
  phase: "active" | "terminal";
  id?: string /** message_start is the authoritative boundary while SDK IDs hydrate. */;
  started?: true;
  start: number;
  count: number;
  terminalText?: string;
};
/** Internal persisted lifecycle marker; task projections expose entries only. */ export type ThreadSnapshot =
  { entries: ThreadEntry[]; frame?: ThreadFrame };
const LIMIT = 8_000;
const ENTRY_LIMIT = 100;
const EVENT_LIMIT = 200;
const PRIVATE_KEY =
  /(?:^|_)(?:nested_?session_?path|file_?path|definition|instructions?|cwd|home|token|secret|password)(?:$|_)/i;

const clean = (value: unknown, limit = LIMIT) =>
  typeof value === "string"
    ? value.replace(/\u001b\[[0-9;]*m/g, "").slice(0, limit)
    : undefined;
const safeRole = (value: unknown): ThreadEntry["role"] | undefined =>
  ["user", "assistant", "tool", "thinking", "custom"].includes(String(value))
    ? (value as ThreadEntry["role"])
    : undefined;
const safeName = (value: unknown) =>
  clean(value, 120)
    ?.replace(/[\r\n\t]+/g, " ")
    .trim() || undefined;
const safeToolCallId = (value: unknown) =>
  clean(value, 120)
    ?.replace(/[\r\n\t]+/g, " ")
    .trim() || undefined;
type SanitizedJsonValue =
  | string
  | number
  | boolean
  | null
  | SanitizedJsonValue[]
  | { [key: string]: SanitizedJsonValue };
const safeValue = (
  value: unknown,
  depth = 0,
): SanitizedJsonValue | undefined => {
  if (depth > 4) return "[truncated]";
  if (typeof value === "string") return clean(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null)
    return value;
  if (Array.isArray(value))
    return value.slice(0, 20).map((item) => safeValue(item, depth + 1) ?? null);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !PRIVATE_KEY.test(key))
        .slice(0, 20)
        .flatMap(([key, item]) => {
          const safe = safeValue(item, depth + 1);
          return safe === undefined ? [] : [[key, safe]];
        }),
    );
  return undefined;
};
const structured = (value: unknown) => {
  const safe = safeValue(value);
  if (safe === undefined) return undefined;
  try {
    return JSON.stringify(safe).slice(0, LIMIT);
  } catch {
    return undefined;
  }
};
const contentEntries = (
  role: ThreadEntry["role"],
  content: unknown,
): ThreadEntry[] => {
  if (typeof content === "string")
    return clean(content) ? [{ role, text: clean(content)! }] : [];
  if (!Array.isArray(content)) return [];
  return content.slice(0, 40).flatMap((part): ThreadEntry[] => {
    if (typeof part === "string")
      return clean(part) ? [{ role, text: clean(part)! }] : [];
    if (!part || typeof part !== "object") return [];
    const item = part as Record<string, unknown>;
    const kind = String(item.type ?? "").toLowerCase();
    const body =
      clean(item.text) ?? clean(item.thinking) ?? clean(item.content);
    return body
      ? [
          {
            role:
              kind === "thinking" || kind === "reasoning" ? "thinking" : role,
            text: body,
          },
        ]
      : [];
  });
};
const toolEntry = (event: Record<string, unknown>): ThreadEntry | undefined => {
  const name =
    safeName(
      event.toolName ??
        event.tool_name ??
        (event.tool as Record<string, unknown> | undefined)?.name,
    ) ?? "tool";
  const chunks: string[] = [];
  const args = structured(event.args ?? event.arguments ?? event.input);
  const result =
    event.result ?? event.partialResult ?? event.output ?? event.error;
  const isError = Boolean(event.error ?? event.isError);
  const output =
    typeof result === "object" &&
    result &&
    Array.isArray((result as Record<string, unknown>).content)
      ? contentEntries("tool", (result as Record<string, unknown>).content)
          .map((entry) => entry.text)
          .join("\n")
      : (clean(result) ?? structured(result));
  if (args) chunks.push(`args: ${args}`);
  if (output)
    chunks.push(
      args || isError ? `${isError ? "error" : "result"}: ${output}` : output,
    );
  const toolCallId = safeToolCallId(
    event.toolCallId ??
      event.tool_call_id ??
      (event.toolCall as Record<string, unknown> | undefined)?.id,
  );
  return chunks.length
    ? {
        role: "tool",
        name,
        text: chunks.join("\n").slice(0, LIMIT),
        ...(toolCallId ? { toolCallId } : {}),
      }
    : undefined;
};
const mergeToolEntry = (
  previous: ThreadEntry,
  next: ThreadEntry,
): ThreadEntry => {
  const previousArgs = previous.text
    .split("\n")
    .filter((line) => line.startsWith("args: "));
  const nextArgs = next.text
    .split("\n")
    .filter((line) => line.startsWith("args: "));
  const nextOutput = next.text
    .split("\n")
    .filter((line) => !line.startsWith("args: "));
  const text = [...(nextArgs.length ? nextArgs : previousArgs), ...nextOutput]
    .join("\n")
    .slice(0, LIMIT);
  return {
    ...next,
    text,
    ...(previous.toolCallId ? { toolCallId: previous.toolCallId } : {}),
  };
};
type FrameBounds = Pick<ThreadFrame, "start" | "count">;
const messageFrameId = (event: Record<string, unknown>) =>
  safeToolCallId(
    event.id ??
      event.messageId ??
      event.message_id ??
      event.responseId ??
      event.response_id,
  );
const retainFrameBounds = (
  bounds: FrameBounds,
  length: number,
): FrameBounds | undefined => {
  const offset = Math.max(0, length - ENTRY_LIMIT);
  const start = Math.max(0, bounds.start - offset);
  const end = Math.min(ENTRY_LIMIT, bounds.start + bounds.count - offset);
  return end > start ? { start, count: end - start } : undefined;
};
const frameText = (entries: ThreadEntry[], role: ThreadFrame["role"]) => {
  for (let index = entries.length - 1; index >= 0; index--)
    if (entries[index].role === role) return entries[index].text;
  return undefined;
};
const isToolEvent = (type: string, outer: Record<string, unknown>) =>
  type.includes("tool_execution") ||
  type.includes("tool_call") ||
  type.includes("tool_result") ||
  Boolean(outer.toolName || outer.tool_name);
const isMessageLifecycle = (type: string) =>
  type === "message_start" ||
  type === "message_update" ||
  type === "message_end";

/** Converts Pi nested message/tool events into a bounded, path-free internal timeline. */
export function buildThreadSnapshot(events: unknown[]): ThreadSnapshot {
  const entries: ThreadEntry[] = [];
  for (const raw of events.slice(-EVENT_LIMIT)) {
    const outer =
      raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const existingRole = safeRole(outer.role);
    if (existingRole && clean(outer.text)) {
      entries.push({
        role: existingRole,
        text: clean(outer.text)!,
        ...(safeName(outer.name) ? { name: safeName(outer.name) } : {}),
        ...(safeToolCallId(outer.toolCallId)
          ? { toolCallId: safeToolCallId(outer.toolCallId) }
          : {}),
      });
      continue;
    }
    const event =
      outer.message && typeof outer.message === "object"
        ? (outer.message as Record<string, unknown>)
        : outer;
    const type = String(outer.type ?? event.type ?? "").toLowerCase();
    if (isToolEvent(type, outer)) {
      const tool = toolEntry(outer);
      if (tool) entries.push(tool);
      continue;
    }
    // Turn and agent envelopes can repeat a terminal message; only lifecycle events may contribute message content to the transcript.
    if (type && !isMessageLifecycle(type)) continue;
    const role =
      safeRole(event.role) ?? (type.includes("custom") ? "custom" : undefined);
    if (!role) continue;
    const parts = contentEntries(role, event.content);
    if (parts.length) {
      entries.push(...parts);
      continue;
    }
    const body = clean(event.text) ?? clean(event.result);
    if (body)
      entries.push({
        role,
        text: body,
        ...(safeName(event.name) ? { name: safeName(event.name) } : {}),
      });
  }
  return { entries: entries.slice(-ENTRY_LIMIT) };
}
/** Validates untrusted persisted JSON before a panel ever renders it. */
export function sanitizeThreadSnapshot(value: unknown): ThreadSnapshot {
  const source =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const raw = Array.isArray(source.entries) ? source.entries : [];
  const entries = raw.slice(-ENTRY_LIMIT).flatMap((entry): ThreadEntry[] => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    const role = safeRole(item.role);
    const text = clean(item.text);
    const name = safeName(item.name);
    const toolCallId = safeToolCallId(item.toolCallId);
    return role && text
      ? [
          {
            role,
            text,
            ...(name ? { name } : {}),
            ...(role === "tool" && toolCallId ? { toolCallId } : {}),
          },
        ]
      : [];
  });
  const candidate = source.frame;
  if (!candidate || typeof candidate !== "object") return { entries };
  const frame = candidate as Record<string, unknown>;
  const role =
    frame.role === "user" || frame.role === "assistant"
      ? frame.role
      : undefined;
  const phase =
    frame.phase === "active" || frame.phase === "terminal"
      ? frame.phase
      : undefined;
  const id = safeToolCallId(frame.id);
  const start = frame.start;
  const count = frame.count;
  const terminalText = clean(frame.terminalText);
  if (
    !role ||
    !phase ||
    !Number.isInteger(start) ||
    !Number.isInteger(count) ||
    (start as number) < 0 ||
    (count as number) < 0 ||
    ((count as number) === 0 &&
      (phase !== "active" || frame.started !== true)) ||
    (start as number) + (count as number) > entries.length ||
    (phase === "terminal" && (role !== "assistant" || !terminalText))
  )
    return { entries };
  const framed = entries.slice(
    start as number,
    (start as number) + (count as number),
  );
  if (
    (count as number) > 0 &&
    !framed.some(
      (entry) =>
        entry.role === role ||
        (role === "assistant" && entry.role === "thinking"),
    )
  )
    return { entries };
  return {
    entries,
    frame: {
      role,
      phase,
      ...(id ? { id } : {}),
      ...(frame.started === true ? { started: true as const } : {}),
      start: start as number,
      count: count as number,
      ...(terminalText ? { terminalText } : {}),
    },
  };
}
export function appendThreadEvent(
  snapshot: ThreadSnapshot | undefined,
  event: unknown,
): ThreadSnapshot {
  const outer =
    event && typeof event === "object"
      ? (event as Record<string, unknown>)
      : {};
  const message =
    outer.message && typeof outer.message === "object"
      ? (outer.message as Record<string, unknown>)
      : outer;
  const type = String(outer.type ?? message.type ?? "").toLowerCase();
  const next = buildThreadSnapshot([event]).entries;
  const previous = sanitizeThreadSnapshot(snapshot);
  const lifecycleRole =
    message.role === "user" || message.role === "assistant"
      ? message.role
      : undefined;
  const isLifecycle =
    (type === "message_start" ||
      type === "message_update" ||
      type === "message_end") &&
    lifecycleRole;
  const isManagerResult =
    !type &&
    !outer.message &&
    outer.role === "assistant" &&
    typeof outer.content === "string";
  if (
    isManagerResult &&
    previous.frame?.role === "assistant" &&
    previous.frame.phase === "terminal" &&
    previous.frame.terminalText === next[0]?.text &&
    next.length === 1
  )
    return previous;
  if (!next.length) {
    if (isToolEvent(type, outer)) return { entries: previous.entries };
    if (isLifecycle && previous.frame && previous.frame.role !== lifecycleRole)
      return { entries: previous.entries };
    if (type === "message_start" && lifecycleRole) {
      const id = messageFrameId(message) ?? messageFrameId(outer);
      return sanitizeThreadSnapshot({
        entries: previous.entries,
        frame: {
          role: lifecycleRole,
          phase: "active",
          ...(id ? { id } : {}),
          started: true,
          start: previous.entries.length,
          count: 0,
        },
      });
    }
    return previous;
  }
  const entries = [...previous.entries];
  let frame: ThreadFrame | undefined;
  const id = messageFrameId(message) ?? messageFrameId(outer);
  const replaces =
    isLifecycle &&
    type !== "message_start" &&
    previous.frame?.phase === "active" &&
    previous.frame.role === lifecycleRole &&
    (previous.frame.started === true || previous.frame.id === id);
  if (replaces && previous.frame) {
    entries.splice(previous.frame.start, previous.frame.count, ...next);
    frame = {
      role: lifecycleRole!,
      phase: type === "message_end" ? "terminal" : "active",
      ...((id ?? previous.frame.id) ? { id: id ?? previous.frame.id } : {}),
      ...(previous.frame.started ? { started: true as const } : {}),
      start: previous.frame.start,
      count: next.length,
    };
  } else {
    const start = entries.length;
    for (const entry of next) {
      let existing = -1;
      if (entry.role === "tool" && entry.toolCallId)
        for (let index = entries.length - 1; index >= 0; index--)
          if (
            entries[index].role === "tool" &&
            entries[index].toolCallId === entry.toolCallId
          ) {
            existing = index;
            break;
          }
      if (existing >= 0)
        entries[existing] = mergeToolEntry(entries[existing], entry);
      else entries.push(entry);
    }
    if (isLifecycle)
      frame = {
        role: lifecycleRole!,
        phase: type === "message_end" ? "terminal" : "active",
        ...(id ? { id } : {}),
        ...(type === "message_start" ? { started: true as const } : {}),
        start,
        count: next.length,
      };
  }
  const bounds =
    frame && frame.count === 0 && frame.started
      ? { start: Math.min(frame.start, ENTRY_LIMIT), count: 0 }
      : frame && retainFrameBounds(frame, entries.length);
  if (frame && bounds) {
    frame = { ...frame, ...bounds };
    if (frame.phase === "terminal") {
      const terminalText = frameText(next, "assistant");
      if (terminalText) frame.terminalText = terminalText;
      else frame = undefined;
    }
  } else frame = undefined;
  return sanitizeThreadSnapshot({
    entries: entries.slice(-ENTRY_LIMIT),
    ...(frame ? { frame } : {}),
  });
}
export function taskThread(
  task: Pick<ForegroundTask, "thread">,
): ThreadSnapshot {
  return sanitizeThreadSnapshot(task.thread);
}
