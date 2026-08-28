import { describe, expect, it, vi } from "vitest";
import { createLiveActivityState, processSubagentEvent } from "../../src/subagents-runtime/event-processing.js";
import { buildPublicTaskSnapshot } from "../../src/subagents-runtime/snapshot-builder.js";
import { ForegroundTaskManager } from "../../src/subagents-runtime/manager.js";
import { taskFromDetails } from "../../src/subagents-runtime/render/formatting.js";
import { progressText } from "../../src/subagents-runtime/render/progress.js";
import type { RuntimeAgentDefinition } from "../../src/subagents-runtime/types.js";

const definition: RuntimeAgentDefinition = { name: "worker", description: "worker", scope: "global", source: "subagents", filePath: "/worker.md", instructions: "work", tools: ["read"] };
const context = { cwd: "/project", projectTrusted: true, sessionId: "owner", orchestrator: {} };

describe("runtime activity and handoff", () => {
  it("keeps bounded, sanitized completed activity separate from the current event", () => {
    let state = createLiveActivityState();
    state = processSubagentEvent(state, { type: "tool_call", toolName: "read", input: { path: "/private/token" } });
    expect(state).toMatchObject({ trail: [], current: { label: "Reading files", kind: "fallback" } });
    state = processSubagentEvent(state, { type: "tool_update", toolName: "read" });
    expect(state).toMatchObject({ trail: [], current: { label: "Reading files", kind: "fallback" } });
    state = processSubagentEvent(state, { type: "tool_end", toolName: "read" });
    expect(state).toMatchObject({ trail: [{ label: "Reading files", kind: "fallback" }] });
    expect(state.current).toBeUndefined();
    state = processSubagentEvent(state, { type: "message_end", message: { usage: { input: 4, output: 2 }, content: "secret response" } });
    for (let index = 0; index < 12; index++) state = processSubagentEvent(state, { type: "tool_end", toolName: `tool-${index}` });
    expect(state.trail).toHaveLength(2);
    expect(state.trail.at(-1)).toEqual({ label: "Using tool", kind: "fallback" });
    expect(state.trail[0]?.label).not.toContain("/private/token");
    expect(state.usage).toEqual({ input: 4, output: 2 });
  });

  it("drops noisy lifecycle labels and deduplicates the bounded completed trail", () => {
    let state = createLiveActivityState();
    for (const type of ["turn_start", "message_update", "agent_start", "auto_retry_start", "agent_end", "turn_end"]) state = processSubagentEvent(state, { type });
    for (let index = 0; index < 12; index++) state = processSubagentEvent(state, { type: "tool_end", toolName: index % 2 ? "write" : "read" });
    expect(state).toEqual({ trail: [{ label: "Reading files", kind: "fallback" }, { label: "Editing files", kind: "fallback" }] });
  });

  it("extracts only the last safe standalone semantic heading from assistant thinking updates", () => {
    let state = createLiveActivityState();
    state = processSubagentEvent(state, { type: "message_update", message: { role: "assistant", content: [{ type: "thinking", thinking: "ordinary reasoning\n**Inspecting package command test scripts**\nmore reasoning\n**Applying minimal test replacements**" }, { type: "text", text: "final assistant text **Never show this**" }] } });
    expect(state.current).toEqual({ label: "Applying minimal test replacements", kind: "semantic" });
    state = processSubagentEvent(state, { type: "message_update", message: { role: "assistant", content: [{ type: "thinking", thinking: "**Adjusting keybinding migration tests**" }] } });
    expect(state.trail).toEqual([{ label: "Applying minimal test replacements", kind: "semantic" }]);
    expect(state.current).toEqual({ label: "Adjusting keybinding migration tests", kind: "semantic" });
  });

  it("retains the latest safe heading when a newer cumulative heading is unsafe", () => {
    const state = processSubagentEvent(createLiveActivityState(), { type: "message_update", message: { role: "assistant", content: [{ type: "thinking", thinking: "**Safe heading**\n**Open example.com**" }] } });
    expect(state.current).toEqual({ label: "Safe heading", kind: "semantic" });
  });

  it("uses safe humanized fallbacks and never treats non-assistant lifecycle starts as thinking", () => {
    let state = createLiveActivityState();
    for (const toolName of ["read", "grep", "edit", "bash", "unknown_tool"]) state = processSubagentEvent(state, { type: "tool_call", toolName, input: { path: "/private/token" } });
    expect(state.current).toEqual({ label: "Using tool", kind: "fallback" });
    expect(state.trail.map((entry) => entry.label)).toEqual(["Reading files", "Searching code", "Editing files", "Running commands"]);
    state = processSubagentEvent(state, { type: "message_start", message: { role: "user" } });
    expect(state.current).toEqual({ label: "Using tool", kind: "fallback" });
    state = processSubagentEvent(state, { type: "message_start", message: { role: "assistant" } });
    expect(state.current).toEqual({ label: "Thinking", kind: "fallback" });
  });

  it("rejects unsafe headings and ordinary reasoning before bounding", () => {
    const unsafe = ["**Read (/home/me/secret)**", "**Open ../private/token**", "**Open \\\\server\\share\\secret**", "**Open https://example.test**", "**Open example.com**", "**Open mailto:user@example.com**", "**Open ssh://host**", "**Use bearer abc123**", "**Use secret: abc123**", "**Set api_key=abc123**", "**Set password: abc123**", "**Read credentials.pem**", "**Use sk-abcdefghijklmnopqrstuvwxyz0123456789**", "**Use github_pat_abcdefghijklmnopqrstuvwxyz0123456789**", "**Use AKIA1234567890ABCDEF**", "**Safe\u001b[31m heading**", "**Safe\u009b heading**", "**Safe\u202e heading**", `**${"Safe summary ".repeat(12)}token=unsafe**`, "ordinary reasoning paragraph"];
    for (const heading of unsafe) {
      const state = processSubagentEvent(createLiveActivityState(), { type: "message_update", message: { role: "assistant", content: [{ type: "thinking", thinking: heading }] } });
      expect(state.current).toBeUndefined();
    }
  });

  it("sanitizes snapshot and external render activity boundaries", () => {
    const unsafe = { label: "Read /private/token", kind: "semantic" };
    const snapshot = buildPublicTaskSnapshot({ id: "task", agent: "worker", task: "work", status: "running", createdAt: "now", liveActivity: { trail: [unsafe, { label: "Reading files", kind: "fallback" }, { label: "Untrusted label", kind: "fallback" }], current: unsafe } } as any);
    expect(snapshot.liveActivity).toEqual({ trail: [{ label: "Reading files", kind: "fallback" }] });
    const external = taskFromDetails({ results: [{ id: "task", agent: "worker", task: "delegated secret task", lastActivity: "external secret", status: "running", mode: "task", attempt: 1, effort: "low", liveActivity: { trail: [unsafe, { label: "Injected", kind: "fallback" }], current: unsafe } }] });
    expect(external?.liveActivity).toEqual({ trail: [] });
    const text = progressText(external);
    expect(text).toContain("↳ Working");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("Injected");
  });

  it("keeps eight unique safe semantic headings", () => {
    let state = createLiveActivityState();
    for (let index = 0; index < 10; index++) state = processSubagentEvent(state, { type: "message_update", message: { role: "assistant", content: [{ type: "reasoning", reasoning: `**Safe semantic heading number ${index}**` }] } });
    expect(state.trail).toHaveLength(8);
    expect(state.trail.map((entry) => entry.label)).toEqual(Array.from({ length: 8 }, (_, index) => `Safe semantic heading number ${index + 1}`));
    expect(state.current).toEqual({ label: "Safe semantic heading number 9", kind: "semantic" });
  });

  it("renders only the last three unique semantic headings, with the current heading accented", () => {
    const text = progressText({ id: "task", agent: "worker", task: "work", status: "running", mode: "task", attempt: 1, effort: "low", liveActivity: { trail: [{ label: "Reading files", kind: "fallback" }, { label: "Inspecting package command test scripts", kind: "semantic" }, { label: "Applying minimal test replacements", kind: "semantic" }, { label: "Inspecting package command test scripts", kind: "semantic" }], current: { label: "Adjusting keybinding migration tests", kind: "semantic" } } });
    expect(text).not.toContain("Reading files");
    expect(text).toContain("\u001b[2m↳ Inspecting package command test scripts\u001b[0m");
    expect(text).toContain("\u001b[2m↳ Applying minimal test replacements\u001b[0m");
    expect(text).toContain("\u001b[1;36m↳ Adjusting keybinding migration tests\u001b[0m");
  });

  it("preserves activity markers in bounded public snapshots", () => {
    const snapshot = buildPublicTaskSnapshot({ id: "task", agent: "worker", task: "work", status: "running", createdAt: "now", liveActivity: { trail: [{ label: "Reading files", kind: "fallback" }], current: { label: "Inspecting package command test scripts", kind: "semantic" } } } as any);
    expect(snapshot.liveActivity).toEqual({ trail: [{ label: "Reading files", kind: "fallback" }], current: { label: "Inspecting package command test scripts", kind: "semantic" } });
  });

  it("makes public snapshots bounded and excludes private runtime fields", () => {
    const snapshot = buildPublicTaskSnapshot({ id: "task", agent: "worker", task: "x".repeat(20_000), status: "running", createdAt: "now", result: "r".repeat(20_000), definition: { instructions: "secret" }, parentSessionId: "owner", liveActivity: { trail: [{ label: "read" }] } } as any);
    expect(snapshot.task).toHaveLength(16_000);
    expect(snapshot.result).toHaveLength(16_000);
    expect(snapshot).not.toHaveProperty("definition");
    expect(snapshot).not.toHaveProperty("parentSessionId");
    expect(snapshot.liveActivity).toEqual({ trail: [] });
  });

  it("cancels only the exact session after a double Escape", async () => {
    const runner = vi.fn(({ signal }: any) => new Promise<any>((_, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })));
    const manager = new ForegroundTaskManager({ runner: { run: runner }, catalog: { discover: () => ({ catalog: [definition], definitions: { worker: definition }, diagnostics: [] }) }, routePort: { resolveAgentRoute: () => undefined }, config: { globalModelProfiles: {}, projectModelProfiles: {}, diagnostics: [] } });
    const run = manager.run({ agent: "worker", task: "work" }, context);
    await vi.waitFor(() => expect(runner).toHaveBeenCalled());
    expect(manager.cancelOnDoubleEscape("other")).toBe(false);
    expect(manager.cancelOnDoubleEscape("owner")).toBe(false);
    expect(manager.cancelOnDoubleEscape("owner")).toBe(true);
    await expect(run).resolves.toMatchObject({ results: [{ status: "cancelled" }] });
  });

  it("refreshes progress every ~500ms and clears the ticker after completion", async () => {
    vi.useFakeTimers();
    try {
      let finish!: () => void;
      const gate = new Promise<void>((resolve) => { finish = resolve; });
      const runner = vi.fn(async () => { await gate; return { result: "done" }; });
      const manager = new ForegroundTaskManager({ runner: { run: runner }, catalog: { discover: () => ({ catalog: [definition], definitions: { worker: definition }, diagnostics: [] }) }, routePort: { resolveAgentRoute: () => undefined }, config: { globalModelProfiles: {}, projectModelProfiles: {}, diagnostics: [] } });
      const update = vi.fn();
      const run = manager.run({ agent: "worker", task: "work" }, context, update);
      await vi.advanceTimersByTimeAsync(499);
      expect(update).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(update).toHaveBeenCalledTimes(2);
      finish();
      await run;
      const callsAfterCompletion = update.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(update).toHaveBeenCalledTimes(callsAfterCompletion);
    } finally { vi.useRealTimers(); }
  });

  it("serves lightweight background widget state without reading history", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const history = { list: vi.fn(), get: vi.fn(), save: vi.fn() };
    const manager = new ForegroundTaskManager({ runner: { run: async () => { await gate; return { result: "done" }; } }, catalog: { discover: () => ({ catalog: [definition], definitions: { worker: definition }, diagnostics: [] }) }, routePort: { resolveAgentRoute: () => undefined }, config: { globalModelProfiles: {}, projectModelProfiles: {}, diagnostics: [] }, history: history as any });
    await manager.run({ agent: "worker", task: "private", context: "private", mode: "background" }, context);
    await vi.waitFor(() => expect(manager.backgroundTasks("owner")).toHaveLength(1));
    const [widgetTask] = manager.backgroundTasks("owner");
    expect(widgetTask).toMatchObject({ agent: "worker", mode: "background", status: "running" });
    expect(Object.keys(widgetTask!).sort()).toEqual(["agent", "id", "liveActivity", "mode", "status"]);
    expect(widgetTask).not.toHaveProperty("task");
    expect(widgetTask).not.toHaveProperty("context");
    expect(widgetTask).not.toHaveProperty("thread");
    expect(widgetTask).not.toHaveProperty("result");
    expect(history.list).not.toHaveBeenCalled();
    expect(history.get).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(manager.backgroundTasks("owner")).toEqual([]));
  });

  it("hands off only its exact session foreground work without aborting it", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const runner = vi.fn(async () => { await gate; return { result: "done" }; });
    const manager = new ForegroundTaskManager({ runner: { run: runner }, catalog: { discover: () => ({ catalog: [definition], definitions: { worker: definition }, diagnostics: [] }) }, routePort: { resolveAgentRoute: () => undefined }, config: { globalModelProfiles: {}, projectModelProfiles: {}, diagnostics: [] } });
    const started = manager.run({ agent: "worker", task: "work" }, context);
    await vi.waitFor(() => expect(runner).toHaveBeenCalled());
    expect(manager.handoff("other")).toBe(false);
    expect(manager.handoff("owner")).toBe(true);
    await expect(started).resolves.toMatchObject({ mode: "background", results: [] });
    expect(manager.list("owner")[0]).toMatchObject({ mode: "background", status: "running" });
    finish();
    await vi.waitFor(() => expect(manager.list("owner")[0]?.status).toBe("completed"));
  });
});
