// Independently adapted from the MIT-licensed pi-subagents-j0k3r widget behavior; see THIRD_PARTY_NOTICES.md.
import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import { wrapLineToWidth } from "../render/text-width.js";
import type { PublicForegroundTask } from "../types.js";

type WidgetTask = Pick<PublicForegroundTask, "id" | "agent" | "mode" | "status" | "liveActivity">;
type Entry = { key: string; line: string };
export type BackgroundWidgetAction = { type: "focus-editor" } | { type: "open-task"; taskId: string };
export type BackgroundWidgetInput = { consume?: boolean; action?: BackgroundWidgetAction } | undefined;

const active = (task: WidgetTask) => task.mode === "background" && (task.status === "queued" || task.status === "running");
const activity = (task: WidgetTask) => (task.liveActivity?.current?.label ?? task.liveActivity?.trail.at(-1)?.label ?? task.status).replace(/\s+/g, " ").trim();
const entries = (tasks: WidgetTask[]): Entry[] => {
  const running = tasks.filter(active);
  return running.length ? [{ key: "main", line: "main" }, ...running.map((task) => ({ key: task.id, line: `${task.agent} ${activity(task)}` }))] : [];
};
const selected = (items: Entry[], key: string) => items.some((item) => item.key === key) ? key : items[0]?.key ?? "main";
const transientStorageError = (error: unknown) => error instanceof Error
  && (error as NodeJS.ErrnoException).code === "ERR_SQLITE_ERROR"
  && /database is (locked|busy)/i.test(error.message);

export function renderBackgroundWidgetLines(tasks: WidgetTask[], selectedKey?: string): string[] | undefined {
  const items = entries(tasks); if (!items.length) return undefined;
  const current = selectedKey === undefined ? undefined : selected(items, selectedKey);
  return items.map((item) => `${item.key === current ? "●" : "○"} ${item.line}`);
}

export class BackgroundWidgetState {
  private selectedKey = "main";
  private navigating = false;
  constructor(private readonly tasks: () => WidgetTask[], private readonly onChange?: () => void) {}
  renderLines() { return renderBackgroundWidgetLines(this.tasks(), this.navigating ? selected(entries(this.tasks()), this.selectedKey) : undefined) ?? []; }
  handleTerminalInput(data: string): BackgroundWidgetInput {
    const items = entries(this.tasks());
    if (!items.length) { if (this.navigating || this.selectedKey !== "main") { this.navigating = false; this.selectedKey = "main"; this.onChange?.(); } return undefined; }
    const current = () => selected(items, this.selectedKey);
    if (matchesKey(data, Key.down)) { this.navigating = true; const index = items.findIndex((item) => item.key === current()); this.selectedKey = items[Math.min(index + 1, items.length - 1)]!.key; this.onChange?.(); return { consume: true }; }
    if (matchesKey(data, Key.up)) { if (!this.navigating) return undefined; const index = items.findIndex((item) => item.key === current()); if (index === 0) this.navigating = false; else this.selectedKey = items[index - 1]!.key; this.onChange?.(); return { consume: true }; }
    if (this.navigating && (data === "\r" || data === "\n")) { const key = current(); this.navigating = false; this.onChange?.(); return { consume: true, action: key === "main" ? { type: "focus-editor" } : { type: "open-task", taskId: key } }; }
    if (this.navigating && (matchesKey(data, Key.left) || matchesKey(data, Key.right) || matchesKey(data, Key.escape))) { this.navigating = false; this.onChange?.(); return { consume: true, action: { type: "focus-editor" } }; }
    return this.navigating ? { consume: true } : undefined;
  }
}

export class BackgroundWidget implements Component {
  constructor(private readonly state: BackgroundWidgetState, private readonly theme: any) {}
  invalidate() {}
  handleInput(data: string) { this.state.handleTerminalInput(data); }
  render(width: number) {
    try {
      return this.state.renderLines().flatMap((line) => wrapLineToWidth(line.startsWith("● ") ? (this.theme?.fg?.("warning", this.theme?.bold?.(line) ?? line) ?? line) : line, width));
    } catch (error) {
      if (transientStorageError(error)) return [];
      throw error;
    }
  }
}
