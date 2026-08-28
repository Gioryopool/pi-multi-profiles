import { describe, expect, it, vi } from "vitest";
import { resolveEffectiveRoute } from "../src/subagents-runtime/profile-resolver.js";
import { ForegroundTaskManager } from "../src/subagents-runtime/manager.js";
import type { RuntimeAgentDefinition } from "../src/subagents-runtime/types.js";
import { createForegroundTools } from "../src/subagents-runtime/tools.js";

const definition = (name: string): RuntimeAgentDefinition => ({ name, description: name, scope: "global", source: "agents", filePath: `/${name}.md`, instructions: "Be useful.", tools: ["read"] });

describe("phase 2 foreground runtime", () => {
  it("resolves model and effort independently without compatibility events", () => {
    const route = resolveEffectiveRoute({ agent: "a", sessionId: "s", definition: { ...definition("a"), effort: "low" }, config: { globalModelProfiles: { a: { model: { provider: "profile", id: "m" } } }, projectModelProfiles: {}, diagnostics: [], defaultEffort: "high" }, routePort: { resolveAgentRoute: () => ({ effort: "max" }) }, orchestrator: { model: { provider: "parent", id: "p" }, effort: "medium" } });
    expect(route.model).toMatchObject({ value: { provider: "profile", id: "m" }, source: "profile" });
    expect(route.effort).toMatchObject({ value: "max", source: "route" });
  });

  it("validates, limits concurrency, and retains terminal results", async () => {
    let active = 0; let peak = 0;
    const runner = { run: async ({ definition: d }: any) => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active--; return { result: d.name }; } };
    const manager = new ForegroundTaskManager({ runner, catalog: { discover: () => ({ catalog: [], definitions: { a: definition("a"), b: definition("b") }, diagnostics: [] }) }, routePort: { resolveAgentRoute: () => undefined }, config: { globalModelProfiles: {}, projectModelProfiles: {}, diagnostics: [], maxConcurrency: 1 } });
    await expect(manager.run({ agents: ["A", "b"], task: "work" }, { cwd: "/p", projectTrusted: true, sessionId: "s", orchestrator: {} })).resolves.toMatchObject({ results: [{ status: "completed" }, { status: "completed" }] });
    expect(peak).toBe(1);
    expect(() => manager.validate({ agent: "a", agents: ["b"], task: "x" })).toThrow(/exactly one/i);
    expect(() => manager.validate({ agent: "a", task: " " })).toThrow(/task/i);
  });

  it("cancels an in-flight task", async () => {
    const runner = { run: ({ signal }: any) => new Promise<any>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))) };
    const manager = new ForegroundTaskManager({ runner, catalog: { discover: () => ({ catalog: [], definitions: { a: definition("a") }, diagnostics: [] }) }, routePort: { resolveAgentRoute: () => undefined }, config: { globalModelProfiles: {}, projectModelProfiles: {}, diagnostics: [] } });
    const promise = manager.run({ agent: "a", task: "work" }, { cwd: "/p", projectTrusted: true, sessionId: "s", orchestrator: {} });
    await new Promise((r) => setTimeout(r, 0));
    const id = manager.list("s")[0].id;
    expect(manager.cancel(id, "s")).toBe(true);
    await expect(promise).resolves.toMatchObject({ results: [{ status: "cancelled" }] });
  });

  it("bridges the invocation signal, distinguishes timeout, and isolates sessions", async () => {
    const runner = { run: ({ signal }: any) => new Promise<any>((_, reject) => signal.addEventListener("abort", () => reject(new Error(String(signal.reason))))) };
    const manager = new ForegroundTaskManager({ runner, catalog: { discover: () => ({ catalog: [], definitions: { a: definition("a") }, diagnostics: [{ message: "bad definition" }] }) }, routePort: { resolveAgentRoute: () => undefined }, config: { globalModelProfiles: {}, projectModelProfiles: {}, diagnostics: [], timeoutMs: 5 } });
    const external = new AbortController();
    const cancelled = manager.run({ agent: "a", task: "work" }, { cwd: "/p", projectTrusted: true, sessionId: "one", orchestrator: {} }, undefined, external.signal);
    await new Promise((r) => setTimeout(r, 0)); external.abort("tool cancelled");
    await expect(cancelled).resolves.toMatchObject({ results: [{ status: "cancelled", error: expect.stringMatching(/tool cancelled/) }] });
    const timed = manager.run({ agent: "a", task: "work" }, { cwd: "/p", projectTrusted: true, sessionId: "two", orchestrator: {} });
    await expect(timed).resolves.toMatchObject({ results: [{ status: "failed", error: expect.stringMatching(/timeout/i) }] });
    const id = manager.list("two")[0].id;
    expect(manager.status(id, "one")).toBeUndefined();
    expect(manager.cancel(id, "one")).toBe(false);
  });

  it("launches effective background mode and exposes failed foreground tool runs as errors", async () => {
    const manager = new ForegroundTaskManager({ runner: { run: async () => { throw new Error("runner failed"); } }, catalog: { discover: () => ({ catalog: [], definitions: { a: { ...definition("a"), subagent_mode: "background" } }, diagnostics: [] }) }, routePort: { resolveAgentRoute: () => undefined }, config: { globalModelProfiles: {}, projectModelProfiles: {}, diagnostics: [] } });
    await expect(manager.run({ agent: "a", task: "work" }, { cwd: "/p", projectTrusted: true, sessionId: "s", orchestrator: {} })).resolves.toMatchObject({ mode: "background", results: [] });
    const failedManager = new ForegroundTaskManager({ runner: { run: async () => { throw new Error("runner failed"); } }, catalog: { discover: () => ({ catalog: [], definitions: { a: definition("a") }, diagnostics: [] }) }, routePort: { resolveAgentRoute: () => undefined }, config: { globalModelProfiles: {}, projectModelProfiles: {}, diagnostics: [] } });
    const tools = createForegroundTools(() => failedManager, () => ({ cwd: "/p", projectTrusted: true, sessionId: "s", orchestrator: {} }), "subagent_");
    const result = await tools.find((tool) => tool.name === "subagent_run")!.execute("", { agent: "a", task: "work", mode: "task" }, new AbortController().signal, undefined, {});
    expect((result as any).isError).toBe(true);
    expect((result as any).details.results[0]).toMatchObject({ status: "failed", error: "runner failed" });
  });

  it("resolves mixed members independently and waits only for task-mode members", async () => {
    let releaseTask!: () => void; const taskGate = new Promise<void>((resolve) => { releaseTask = resolve; });
    let releaseBackground!: () => void; const backgroundGate = new Promise<void>((resolve) => { releaseBackground = resolve; });
    const manager = new ForegroundTaskManager({ runner: { run: async ({ definition: d }: any) => { await (d.name === "task" ? taskGate : backgroundGate); return { result: d.name }; } }, catalog: { discover: () => ({ catalog: [], definitions: { task: { ...definition("task"), subagent_mode: "task" }, background: { ...definition("background"), subagent_mode: "background" } }, diagnostics: [] }) }, routePort: { resolveAgentRoute: () => undefined }, config: { globalModelProfiles: {}, projectModelProfiles: {}, diagnostics: [] } });
    const pending = manager.run({ agents: ["task", "background"], task: "work" }, { cwd: "/p", projectTrusted: true, sessionId: "s", orchestrator: {} });
    releaseTask();
    const result = await pending;
    expect(result).toMatchObject({ mode: "mixed", results: [{ agent: "task", status: "completed" }] });
    expect(result.taskIds).toHaveLength(2);
    expect(manager.status(result.taskIds[1], "s")).toMatchObject({ agent: "background", status: "running", mode: "background" });
    releaseBackground();
  });

  it("uses explicit invocation modes to force every multi-agent member", async () => {
    const manager = new ForegroundTaskManager({ runner: { run: async ({ definition: d }: any) => ({ result: d.name }) }, catalog: { discover: () => ({ catalog: [], definitions: { task: { ...definition("task"), subagent_mode: "task" }, background: { ...definition("background"), subagent_mode: "background" } }, diagnostics: [] }) }, routePort: { resolveAgentRoute: () => undefined }, config: { globalModelProfiles: {}, projectModelProfiles: {}, diagnostics: [] } });
    await expect(manager.run({ agents: ["task", "background"], task: "work", mode: "task" }, { cwd: "/p", projectTrusted: true, sessionId: "task", orchestrator: {} })).resolves.toMatchObject({ mode: "task", results: [{ mode: "task" }, { mode: "task" }] });
    await expect(manager.run({ agents: ["task", "background"], task: "work", mode: "background" }, { cwd: "/p", projectTrusted: true, sessionId: "background", orchestrator: {} })).resolves.toMatchObject({ mode: "background", results: [] });
  });

  it("returns resolved send-message results from the public tool", async () => {
    const sent = { accepted: true, state: "queued" };
    const tools = createForegroundTools(
      () => ({ sendMessage: async () => sent }) as any,
      () => ({}),
      "subagent_",
    );
    const result: any = await tools
      .find((tool) => tool.name === "subagent_send_message")!
      .execute(
        "",
        { task_id: "task-1", message: "hello" },
        new AbortController().signal,
        undefined,
        { sessionManager: { getSessionId: () => "parent" } },
      );
    expect(result.details).toEqual(sent);
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(sent) }]);
  });

  it("reports async send-message rejections as public-tool errors", async () => {
    const tools = createForegroundTools(
      () => ({ sendMessage: async () => { throw new Error("message rejected"); } }) as any,
      () => ({}),
      "subagent_",
    );
    const result: any = await tools
      .find((tool) => tool.name === "subagent_send_message")!
      .execute(
        "",
        { task_id: "task-1", message: "hello" },
        new AbortController().signal,
        undefined,
        { sessionManager: { getSessionId: () => "parent" } },
      );
    expect(result).toMatchObject({ isError: true });
    expect(result.content).toEqual([{ type: "text", text: "message rejected" }]);
  });

  it("uses real TypeBox schemas with required and optional fields", () => {
    const tools = createForegroundTools(() => undefined, () => ({}), "subagent_");
    const schema: any = tools.find((tool) => tool.name === "subagent_run")!.parameters;
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["task"]);
    expect(schema.properties.agent).toMatchObject({ type: "string" });
  });
});
