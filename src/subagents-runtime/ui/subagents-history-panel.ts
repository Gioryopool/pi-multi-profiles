import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { PublicForegroundTask } from "../types.js";
import type { ThreadSnapshot } from "../thread-view.js";
import { closeKey, mouseWheelDelta, pageDelta } from "./panel-input.js";
import type { ThreadEntryRenderer } from "./thread-components.js";

export type HistoryPanelOptions = {
  tasks: () => PublicForegroundTask[];
  detail: (id: string) => ThreadSnapshot | undefined;
  cancel: (id: string) => boolean;
  close: () => void;
  initialTaskId?: string;
  detailCancelKey?: string;
  requestRender?: () => void;
  theme?: Theme;
  renderEntry?: ThreadEntryRenderer;
  maxLines?: number | (() => number);
  timeoutMs?: number;
  stallTimeoutMs?: number;
  contextWindowForTask?: (task: PublicForegroundTask) => number | undefined;
};
const terminal = (status: string) =>
  ["completed", "failed", "cancelled", "interrupted"].includes(status);
const clip = (value: unknown, width: number) =>
  truncateToWidth(
    typeof value === "string" ? value.replace(/[\r\n]+/g, " ") : "",
    Math.max(1, width),
    "…",
    false,
  );
const tone = (
  theme: Theme | undefined,
  color: Parameters<Theme["fg"]>[0],
  text: string,
) => theme?.fg(color, text) ?? text;
const bold = (theme: Theme | undefined, text: string) =>
  theme?.bold(text) ?? text;
const normalized = (value: string, limit = 8_000) => {
  const compact = value.replace(/\s+/g, " ").trim().toLowerCase();
  return compact.length <= limit ? compact : undefined;
};
const hasFinalResponse = (
  detail: ThreadSnapshot | undefined,
  result: string,
) => {
  const expected = normalized(result);
  if (!expected) return false;
  const assistant = [...(detail?.entries ?? [])]
    .reverse()
    .find((entry) => entry.role === "assistant");
  return assistant ? normalized(assistant.text) === expected : false;
};
const formatDuration = (task: PublicForegroundTask) => {
  const start = Date.parse(task.startedAt ?? task.createdAt);
  const end =
    Date.parse(task.finishedAt ?? "") ||
    (terminal(task.status) ? NaN : Date.now());
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "–";
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  return seconds >= 60
    ? `${Math.floor(seconds / 60)}m${seconds % 60 ? `${seconds % 60}s` : ""}`
    : `${seconds}s`;
};
const formatTimeout = (milliseconds?: number) => {
  if (!Number.isFinite(milliseconds) || !milliseconds || milliseconds <= 0)
    return undefined;
  const seconds = Math.max(1, Math.round(milliseconds / 1000));
  return seconds >= 60
    ? `${Math.floor(seconds / 60)}m${seconds % 60 ? `${seconds % 60}s` : ""}`
    : `${seconds}s`;
};
const formatTokens = (value: number) =>
  value < 1_000
    ? String(value)
    : value < 10_000
      ? `${(value / 1_000).toFixed(1)}k`
      : `${Math.round(value / 1_000)}k`;
const formatUsage = (usage: unknown, contextWindow?: number) => {
  if (!usage || typeof usage !== "object") return "";
  const value = usage as Record<string, unknown>;
  const number = (...keys: string[]) =>
    keys
      .map((key) => value[key])
      .find(
        (item): item is number =>
          typeof item === "number" && Number.isFinite(item),
      );
  const parts: string[] = [];
  const turns = number("turns");
  if (turns) parts.push(`${turns} turn${turns === 1 ? "" : "s"}`);
  const input = number("input", "inputTokens");
  if (input !== undefined) parts.push(`↑${formatTokens(input)}`);
  const output = number("output", "outputTokens");
  if (output !== undefined) parts.push(`↓${formatTokens(output)}`);
  const context = number("contextTokens", "context_tokens");
  if (context !== undefined) {
    const percentage =
      contextWindow && contextWindow > 0
        ? ` (${Number(((context / contextWindow) * 100).toFixed(1))}%)`
        : "";
    parts.push(`ctx:${formatTokens(context)}${percentage}`);
  }
  return parts.join(" ");
};

/** Full-width execution history with a horizontal task strip and a scrolling detail body. */
export class SubagentsHistoryPanel implements Component {
  private cursor = 0;
  private detailScroll = 0;
  private followTail = true;
  private lastMaxScroll = 0;
  showOutput = false;
  showThinking = true;
  constructor(private readonly options: HistoryPanelOptions) {
    const index = options.initialTaskId
      ? options.tasks().findIndex((task) => task.id === options.initialTaskId)
      : -1;
    if (index >= 0) this.cursor = index;
  }
  selected() {
    const tasks = this.options.tasks();
    this.cursor = Math.max(
      0,
      Math.min(this.cursor, Math.max(0, tasks.length - 1)),
    );
    return tasks[this.cursor];
  }
  private redraw() {
    this.options.requestRender?.();
  }
  private moveTask(delta: number) {
    const tasks = this.options.tasks();
    if (!tasks.length) return;
    this.cursor = Math.max(0, Math.min(tasks.length - 1, this.cursor + delta));
    this.detailScroll = 0;
    this.followTail = true;
    this.redraw();
  }
  private scrollDetail(delta: number) {
    this.detailScroll = Math.max(0, this.detailScroll + delta);
    this.followTail = this.detailScroll >= this.lastMaxScroll;
    this.redraw();
  }
  handleInput(data: string) {
    if (closeKey(data) || matchesKey(data, "ctrl+c"))
      return this.options.close();
    if (matchesKey(data, Key.left) || matchesKey(data, "h"))
      return this.moveTask(-1);
    if (matchesKey(data, Key.right) || matchesKey(data, "l"))
      return this.moveTask(1);
    if (matchesKey(data, Key.up) || matchesKey(data, "k"))
      return this.scrollDetail(-1);
    if (matchesKey(data, Key.down) || matchesKey(data, "j"))
      return this.scrollDetail(1);
    if (matchesKey(data, Key.home)) {
      this.detailScroll = 0;
      this.followTail = false;
      return this.redraw();
    }
    if (matchesKey(data, Key.end)) {
      this.detailScroll = Number.MAX_SAFE_INTEGER;
      this.followTail = true;
      return this.redraw();
    }
    const page = pageDelta(data);
    if (page) return this.scrollDetail(page);
    const wheel = mouseWheelDelta(data);
    if (wheel) return this.scrollDetail(wheel);
    if (matchesKey(data, "ctrl+o")) {
      this.showOutput = !this.showOutput;
      return this.redraw();
    }
    if (matchesKey(data, "ctrl+t")) {
      this.showThinking = !this.showThinking;
      return this.redraw();
    }
    if (matchesKey(data, (this.options.detailCancelKey ?? "x") as any)) {
      const task = this.selected();
      if (
        task &&
        (task.status === "queued" || task.status === "running") &&
        this.options.cancel(task.id)
      )
        this.redraw();
    }
  }
  invalidate() {
    this.redraw();
  }
  render(width: number) {
    return renderHistoryPanel(this, width);
  }
  state() {
    const selected = this.selected();
    return {
      tasks: this.options.tasks(),
      selected,
      selectedIndex: this.cursor,
      detail: selected ? this.options.detail(selected.id) : undefined,
      detailScroll: this.detailScroll,
      followTail: this.followTail,
    };
  }
  setScroll(value: number, max: number) {
    this.lastMaxScroll = max;
    this.detailScroll = Math.max(0, Math.min(value, max));
  }
  maxLines() {
    const configured =
      typeof this.options.maxLines === "function"
        ? this.options.maxLines()
        : this.options.maxLines;
    return Math.max(
      12,
      Math.floor(Number.isFinite(configured) ? configured! : 42),
    );
  }
  cancelKey() {
    return this.options.detailCancelKey ?? "x";
  }
  theme() {
    return this.options.theme;
  }
  renderEntry(entry: Parameters<ThreadEntryRenderer>[0], width: number) {
    return this.options.renderEntry?.(entry, width, this.showOutput);
  }
}
function strip(
  tasks: PublicForegroundTask[],
  selectedIndex: number,
  width: number,
  theme: Theme | undefined,
) {
  if (!tasks.length) return "";
  const chip = (index: number) =>
    `${index === selectedIndex ? "●" : "○"} ${tasks[index]!.agent}:${tasks[index]!.status}${tasks[index]!.attempt ? ` attempt:${tasks[index]!.attempt}` : ""}`;
  let start = selectedIndex;
  let end = selectedIndex + 1;
  let content = chip(selectedIndex);
  while (start > 0 || end < tasks.length) {
    const next =
      start > 0 && selectedIndex - start <= end - selectedIndex - 1
        ? start - 1
        : end < tasks.length
          ? end
          : start - 1;
    const candidate =
      next < start ? `${chip(next)}  ${content}` : `${content}  ${chip(next)}`;
    if (
      visibleWidth(
        `executions ${Math.min(start, next) + 1}-${Math.max(end, next + 1)}/${tasks.length}  ${candidate}`,
      ) > width
    )
      break;
    content = candidate;
    start = Math.min(start, next);
    end = Math.max(end, next + 1);
  }
  const styled = content
    .split("  ")
    .map((item) =>
      item.startsWith("●")
        ? (theme?.bg("selectedBg", tone(theme, "accent", bold(theme, item))) ??
          item)
        : tone(theme, "muted", tone(theme, "dim", item)),
    )
    .join("  ");
  return `executions ${start + 1}-${end}/${tasks.length}  ${start ? "‹ " : ""}${styled}${end < tasks.length ? " ›" : ""}`;
}
export function renderHistoryPanel(
  panel: SubagentsHistoryPanel,
  width: number,
): string[] {
  const inner = Math.max(1, width);
  const maxLines = panel.maxLines();
  const { tasks, selected, selectedIndex, detail, detailScroll, followTail } =
    panel.state();
  const line = (value = "") => clip(value, inner);
  const theme = panel.theme();
  const label = (value: string) => tone(theme, "muted", value);
  const status = (value: string) =>
    tone(
      theme,
      value === "completed" ? "success" : terminal(value) ? "error" : "warning",
      value,
    );
  const separator = () => tone(theme, "borderMuted", "─".repeat(inner));
  const lines = [
    line(
      `${tone(theme, "accent", bold(theme, "subagents session execution flow"))}${tone(theme, "dim", ` · ←/→ executions · ↑/↓ scroll · pgup/pgdn · ctrl+o output · ctrl+t thinking · ${panel.cancelKey()} cancel · esc/q close`)}`,
    ),
    separator(),
  ];
  if (!selected) {
    lines.push(
      line(
        tone(theme, "dim", "No subagent tasks recorded in this session yet."),
      ),
    );
    while (lines.length < maxLines) lines.push("");
    return lines;
  }
  const usage = formatUsage(
    selected.usage,
    panel["options"].contextWindowForTask?.(selected),
  );
  const timeout = formatTimeout(panel["options"].timeoutMs);
  const stall = formatTimeout(panel["options"].stallTimeoutMs);
  const model = selected.model
    ? `${selected.model.provider}/${selected.model.id}`
    : "current";
  const activity = [
    ...(selected.liveActivity?.trail ?? []).map((item) => item.label),
    selected.liveActivity?.current?.label,
  ].filter((item): item is string => Boolean(item));
  lines.push(
    line(
      `${selectedIndex + 1}/${tasks.length}  ${label("agent:")} ${selected.agent}  ${label("status:")} ${status(selected.status)}  ${label("attempt:")} ${selected.attempt ?? 1}  ${label("mode:")} ${selected.mode ?? "task"}${selected.status === "queued" || selected.status === "running" ? tone(theme, "dim", ` (${panel.cancelKey()} cancel)`) : ""}`,
    ),
  );
  lines.push(
    line(
      `${label("model:")} ${model}  ${label("effort:")} ${selected.effort ?? "default"}${timeout ? `  ${label("timeout")} ${timeout}` : ""}  ${label("id:")} ${selected.id}  ${label("duration:")} ${formatDuration(selected)}`,
    ),
  );
  if (usage) lines.push(line(`${label("usage:")} ${usage}`));
  if (activity.length)
    lines.push(
      line(
        `${label("last activity:")} ${activity.at(-1)}${stall ? `  ${label("stall")} ${stall}` : ""}`,
      ),
    );
  else if (stall)
    lines.push(
      line(`${label("last activity:")} n/a  ${label("stall")} ${stall}`),
    );
  lines.push(line(`${label("task:")} ${selected.task}`));
  lines.push(line(strip(tasks, selectedIndex, inner, theme)));
  lines.push(separator());
  const body: string[] = [];
  for (const item of activity) body.push(line(`${label("activity:")} ${item}`));
  for (const entry of detail?.entries ?? []) {
    if (entry.role === "thinking" && !panel.showThinking) continue;
    if (entry.role === "tool" && !panel.showOutput) {
      body.push(
        line(
          `${tone(theme, "toolTitle", `tool:${entry.name ?? "tool"}:`)}${tone(theme, "dim", " compact · Ctrl+O to expand")}`,
        ),
      );
      continue;
    }
    try {
      const rendered = panel.renderEntry(entry, inner);
      const fallback =
        entry.role === "thinking"
          ? tone(theme, "thinkingText", `thinking: ${entry.text}`)
          : `${entry.role}${entry.name ? `:${entry.name}` : ""}: ${entry.text}`;
      body.push(
        ...(rendered?.length ? rendered : [fallback])
          .flatMap((item) => item.split(/\r?\n/))
          .map((item) => line(item)),
      );
    } catch {
      body.push(
        line(
          entry.role === "thinking"
            ? tone(theme, "thinkingText", `thinking: ${entry.text}`)
            : `${entry.role}${entry.name ? `:${entry.name}` : ""}: ${entry.text}`,
        ),
      );
    }
  }
  if (selected.result && !hasFinalResponse(detail, selected.result))
    body.push(
      line(
        `${tone(theme, "customMessageLabel", "response:")} ${tone(theme, "customMessageText", selected.result)}`,
      ),
    );
  if (selected.error)
    body.push(line(tone(theme, "error", `error: ${selected.error}`)));
  if (!body.length)
    body.push(
      selected.status === "queued"
        ? line(`${label("activity:")} queued`)
        : line(tone(theme, "dim", "Preparing for response")),
    );
  const bodyHeight = Math.max(3, maxLines - lines.length - 1);
  const maxScroll = Math.max(0, body.length - bodyHeight);
  const scroll = followTail ? maxScroll : Math.min(detailScroll, maxScroll);
  panel.setScroll(scroll, maxScroll);
  lines.push(...body.slice(scroll, scroll + bodyHeight));
  while (lines.length < maxLines - 1) lines.push("");
  const position =
    body.length > bodyHeight
      ? `${scroll + 1}-${Math.min(body.length, scroll + bodyHeight)}/${body.length}`
      : "";
  lines.push(
    line(
      `${tone(theme, "borderMuted", "─".repeat(Math.max(0, inner - visibleWidth(position))))}${position}`,
    ),
  );
  return lines.slice(0, maxLines);
}
