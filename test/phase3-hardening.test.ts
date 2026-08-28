import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RuntimeHistory } from "../src/subagents-runtime/history.js";
import { ForegroundTaskManager } from "../src/subagents-runtime/manager.js";
import { createForegroundTools } from "../src/subagents-runtime/tools.js";
import type { RuntimeAgentDefinition } from "../src/subagents-runtime/types.js";

const definition: RuntimeAgentDefinition = {
  name: "worker",
  description: "worker",
  scope: "global",
  source: "subagents",
  filePath: "/worker.md",
  instructions: "work",
  tools: ["read"],
};
const context = {
  cwd: "/project",
  projectTrusted: true,
  sessionId: "parent",
  orchestrator: {},
};
function managerWithRunner(
  run: (input: any) => Promise<any>,
  config: any = {},
) {
  return new ForegroundTaskManager({
    runner: { run },
    catalog: {
      discover: () => ({
        catalog: [definition],
        definitions: { worker: definition },
        diagnostics: [],
      }),
    },
    routePort: { resolveAgentRoute: () => undefined },
    config: {
      globalModelProfiles: {},
      projectModelProfiles: {},
      diagnostics: [],
      ...config,
    },
  });
}

describe("Phase 3 hardening", () => {
  it("reports a failed live steer as queued rather than falsely delivered", async () => {
    const steer = vi.fn(async () => {
      throw new Error("bridge down");
    });
    const manager = managerWithRunner(async (input) => {
      input.onLiveBridge({ steer });
      await new Promise(() => {});
    });
    const launch = await manager.run(
      { agent: "worker", task: "work", mode: "background" },
      context,
    );
    await expect(
      manager.sendMessage(launch.taskIds[0], "parent", "retry me"),
    ).resolves.toEqual({ accepted: true, state: "queued" });
    await expect(
      manager.sendMessage(launch.taskIds[0], "other", "no"),
    ).rejects.toThrow(/unknown/i);
  });

  it("accepts an exact 8000-character live message, rejects 8001, and caps the queue at 32", async () => {
    let bridge: any;
    const manager = managerWithRunner(async (input) => {
      bridge = input.onLiveBridge;
      await new Promise(() => {});
    });
    const launch = await manager.run(
      { agent: "worker", task: "work", mode: "background" },
      context,
    );
    await expect(
      manager.sendMessage(launch.taskIds[0], "parent", "x".repeat(8_000)),
    ).resolves.toMatchObject({ accepted: true });
    await expect(
      manager.sendMessage(launch.taskIds[0], "parent", "x".repeat(8_001)),
    ).rejects.toThrow(/8000/);
    for (let index = 0; index < 31; index++)
      await expect(
        manager.sendMessage(launch.taskIds[0], "parent", String(index)),
      ).resolves.toMatchObject({ accepted: true });
    await expect(
      manager.sendMessage(launch.taskIds[0], "parent", "overflow"),
    ).rejects.toThrow(/queue is full/i);
    bridge?.({ steer: async () => {} });
  });

  it("retries a failed steer and delivers queued messages in order", async () => {
    const sent: string[] = [];
    let attempts = 0;
    const manager = managerWithRunner(async (input) => {
      input.onLiveBridge({
        steer: async (message: string) => {
          if (attempts++ === 0) throw new Error("temporary");
          sent.push(message);
        },
      });
      await new Promise(() => {});
    });
    const launch = await manager.run(
      { agent: "worker", task: "work", mode: "background" },
      context,
    );
    await manager.sendMessage(launch.taskIds[0], "parent", "one");
    await manager.sendMessage(launch.taskIds[0], "parent", "two");
    await vi.waitFor(() => expect(sent).toEqual(["one", "two"]));
  });

  it("flushes queued messages in order and notifies each background task once", async () => {
    let bridge: any;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const sent: string[] = [];
    const manager = managerWithRunner(async (input) => {
      bridge = input.onLiveBridge;
      await gate;
      return { result: "done" };
    });
    const notices: string[] = [];
    manager.bindNotifier((message) => {
      notices.push(message);
    });
    const launch = await manager.run(
      { agent: "worker", task: "work", mode: "background" },
      context,
    );
    await expect(
      manager.sendMessage(launch.taskIds[0], "parent", "one"),
    ).resolves.toMatchObject({ state: "queued" });
    bridge({
      steer: async (message: string) => {
        sent.push(message);
      },
    });
    await vi.waitFor(() => expect(sent).toEqual(["one"]));
    await expect(
      manager.sendMessage(launch.taskIds[0], "parent", "two"),
    ).resolves.toMatchObject({ state: "delivered" });
    expect(sent).toEqual(["one", "two"]);
    finish();
    await vi.waitFor(() => expect(notices).toHaveLength(1));
  });

  it("waits for every queued background worker before shutdown permits history close", async () => {
    const definitions = ["worker-1", "worker-2", "worker-3"].map((name) => ({
      ...definition,
      name,
    }));
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let unblockFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      unblockFirst = resolve;
    });
    const saves: string[] = [];
    let closed = false;
    const history = {
      save: (task: any) => {
        if (closed) throw new Error("write after close");
        saves.push(`${task.id}:${task.status}`);
      },
      list: () => [],
      get: () => undefined,
    };
    let calls = 0;
    const manager = new ForegroundTaskManager({
      runner: {
        run: async () => {
          calls += 1;
          if (calls === 1) {
            firstStarted();
            await firstGate;
          }
          return { result: "done" };
        },
      },
      catalog: {
        discover: () => ({
          catalog: definitions,
          definitions: Object.fromEntries(
            definitions.map((item) => [item.name, item]),
          ),
          diagnostics: [],
        }),
      },
      routePort: { resolveAgentRoute: () => undefined },
      config: {
        globalModelProfiles: {},
        projectModelProfiles: {},
        diagnostics: [],
        maxConcurrency: 1,
      },
      history: history as any,
    });
    const launch = await manager.run(
      {
        agents: definitions.map((item) => item.name),
        task: "work",
        mode: "background",
      },
      context,
    );
    await started;
    let shutdownDone = false;
    const shutdown = manager.shutdown("parent").then(() => {
      shutdownDone = true;
    });
    await Promise.resolve();
    expect(shutdownDone).toBe(false);
    unblockFirst();
    await shutdown;
    closed = true;
    expect(calls).toBe(1);
    expect(
      launch.taskIds.map((id) => manager.status(id, "parent")?.status),
    ).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(saves.filter((save) => save.endsWith(":cancelled"))).toHaveLength(3);
    await Promise.resolve();
    expect(saves.filter((save) => save.endsWith(":cancelled"))).toHaveLength(3);
  });

  it("contains locked history writes so eventful work still completes", async () => {
    const history = {
      save: vi.fn(() => {
        const error: any = new Error("database is locked");
        error.code = "ERR_SQLITE_ERROR";
        throw error;
      }),
      list: vi.fn(() => []),
      get: vi.fn(),
    };
    const manager = new ForegroundTaskManager({
      runner: {
        run: async (input) => {
          input.onEvent?.({ type: "tool_call", toolName: "read" });
          return { result: "done" };
        },
      },
      catalog: {
        discover: () => ({
          catalog: [definition],
          definitions: { worker: definition },
          diagnostics: [],
        }),
      },
      routePort: { resolveAgentRoute: () => undefined },
      config: {
        globalModelProfiles: {},
        projectModelProfiles: {},
        diagnostics: [],
      },
      history: history as any,
    });
    const result = await manager.run(
      { agent: "worker", task: "work" },
      context,
    );
    expect(result).toMatchObject({
      results: [{ status: "completed", result: "done" }],
    });
    expect(manager.status(result.taskIds[0]!, "parent")).toMatchObject({
      status: "completed",
    });
  });

  it("coalesces event history snapshots and flushes terminal state immediately", async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const saves: any[] = [];
      const history = {
        save: (task: any) => saves.push(task),
        list: () => [],
        get: () => undefined,
      };
      const manager = new ForegroundTaskManager({
        runner: {
          run: async (input) => {
            for (let index = 0; index < 5; index++)
              input.onEvent?.({ type: "tool_call", toolName: `tool-${index}` });
            await gate;
            return { result: "done" };
          },
        },
        catalog: {
          discover: () => ({
            catalog: [definition],
            definitions: { worker: definition },
            diagnostics: [],
          }),
        },
        routePort: { resolveAgentRoute: () => undefined },
        config: {
          globalModelProfiles: {},
          projectModelProfiles: {},
          diagnostics: [],
        },
        history: history as any,
      });
      const launch = manager.run({ agent: "worker", task: "work" }, context);
      await Promise.resolve();
      expect(saves).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(249);
      expect(saves).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(saves).toHaveLength(3);
      expect(saves[2]).toMatchObject({
        status: "running",
        liveActivity: { current: { label: "Using tool" } },
      });
      release();
      await launch;
      expect(saves).toHaveLength(4);
      expect(saves.at(-1)).toMatchObject({
        status: "completed",
        result: "done",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears pending history records during shutdown", async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let closed = false;
      const history = {
        save: vi.fn(() => {
          if (closed) throw new Error("write after close");
        }),
        list: () => [],
        get: () => undefined,
      };
      const manager = new ForegroundTaskManager({
        runner: {
          run: async (input) => {
            input.onEvent?.({ type: "tool_call", toolName: "read" });
            await gate;
            return { result: "done" };
          },
        },
        catalog: {
          discover: () => ({
            catalog: [definition],
            definitions: { worker: definition },
            diagnostics: [],
          }),
        },
        routePort: { resolveAgentRoute: () => undefined },
        config: {
          globalModelProfiles: {},
          projectModelProfiles: {},
          diagnostics: [],
        },
        history: history as any,
      });
      await manager.run(
        { agent: "worker", task: "work", mode: "background" },
        context,
      );
      expect(history.save).toHaveBeenCalledTimes(2);
      const writesBeforeShutdown = history.save.mock.calls.length;
      release();
      await manager.shutdown("parent");
      closed = true;
      await vi.advanceTimersByTimeAsync(500);
      expect(history.save).toHaveBeenCalledTimes(writesBeforeShutdown + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses in-memory tasks for live progress without history reads", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const history = { save: vi.fn(), list: vi.fn(() => []), get: vi.fn() };
    const manager = new ForegroundTaskManager({
      runner: {
        run: async (input) => {
          input.onEvent?.({ type: "tool_call", toolName: "read" });
          await gate;
          return { result: "done" };
        },
      },
      catalog: {
        discover: () => ({
          catalog: [definition],
          definitions: { worker: definition },
          diagnostics: [],
        }),
      },
      routePort: { resolveAgentRoute: () => undefined },
      config: {
        globalModelProfiles: {},
        projectModelProfiles: {},
        diagnostics: [],
      },
      history: history as any,
    });
    const launch = manager.run(
      { agent: "worker", task: "work" },
      context,
      vi.fn(),
    );
    await vi.waitFor(() => expect(history.save).toHaveBeenCalled());
    expect(history.list).not.toHaveBeenCalled();
    release();
    await launch;
    expect(history.list).not.toHaveBeenCalled();
  });

    it("does not retain progress intervals for effective background runs or continuations", async () => {
      vi.useFakeTimers();
      const intervals = vi.spyOn(global, "setInterval");
      try {
        const root = mkdtempSync(join(tmpdir(), "profiles-sessions-"));
        const session = join(root, "task.jsonl");
        writeFileSync(session, "{}");
        const manager = managerWithRunner(
          ({ signal }) =>
            new Promise((_, reject) =>
              signal.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              }),
            ),
          { defaultMode: "background" },
        );
        (manager as any).dependencies.continuationRoot = () => root;
        const runProgress = vi.fn();
        const launch = await manager.run(
          { agent: "worker", task: "work" },
          context,
          runProgress,
        );
        expect(launch.mode).toBe("background");
        await vi.advanceTimersByTimeAsync(500);
        expect(intervals).not.toHaveBeenCalled();
        expect(runProgress).not.toHaveBeenCalled();
        manager.cancel(launch.taskIds[0]!, "parent");
        await manager.shutdown("parent");

        (manager as any).tasks.set("continued", {
          id: "continued",
          agent: "worker",
          task: "work",
          parentSessionId: "parent",
          status: "completed",
          mode: "background",
          createdAt: "now",
          nestedSessionPath: session,
          definition,
          controller: new AbortController(),
          messages: [],
        });
        const continueProgress = vi.fn();
        const continued: any = await manager.continue(
          "continued",
          "parent",
          "again",
          context,
          undefined,
          undefined,
          continueProgress,
        );
        expect(continued.mode).toBe("background");
        await vi.advanceTimersByTimeAsync(500);
        expect(intervals).not.toHaveBeenCalled();
        expect(continueProgress).not.toHaveBeenCalled();
        manager.cancel("continued", "parent");
        await manager.shutdown("parent");
      } finally {
        intervals.mockRestore();
        vi.useRealTimers();
      }
    });

    it("recovers stale rows once, preserves terminal rows, and safely ignores corrupt payloads", () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "profiles-history-")),
      "history.sqlite",
    );
    const first = new RuntimeHistory(path);
    first.save({
      id: "run",
      parentSessionId: "a",
      agent: "worker",
      task: "x",
      status: "running",
      createdAt: "now",
    });
    first.save({
      id: "done",
      parentSessionId: "a",
      agent: "worker",
      task: "x",
      status: "completed",
      createdAt: "now",
      result: "ok",
    });
    first.close();
    const reopened = new RuntimeHistory(path);
    expect(reopened.get("run", "a")).toMatchObject({ status: "interrupted" });
    expect(reopened.get("done", "a")).toMatchObject({
      status: "completed",
      result: "ok",
    });
    reopened.close();
    expect(() => reopened.list("a")).toThrow(/closed/i);
  });

  it("passes the tool invocation signal to continuation and marks cancellation as an error", async () => {
    const continueTask = vi.fn(
      async (_id, _session, _prompt, _context, signal) => ({
        status: signal.aborted ? "cancelled" : "completed",
      }),
    );
    const tools = createForegroundTools(
      () => ({ continue: continueTask }) as any,
      () => context,
      "subagent_",
    );
    const controller = new AbortController();
    controller.abort("cancelled");
    await expect(
      tools
        .find((tool) => tool.name === "subagent_continue")!
        .execute(
          "",
          { task_id: "task", prompt: "again" },
          controller.signal,
          undefined,
          { sessionManager: { getSessionId: () => "parent" } },
        ),
    ).resolves.toMatchObject({
      isError: true,
      details: { status: "cancelled" },
    });
    expect(continueTask).toHaveBeenCalledWith(
      "task",
      "parent",
      "again",
      context,
      controller.signal,
      undefined,
      expect.any(Function),
    );
  });

  it("enforces disabled continuation before reopening any session", async () => {
    const manager = managerWithRunner(async () => ({ result: "done" }), {
      enableContinue: false,
    });
    await expect(
      manager.continue("unknown", "parent", "again", context),
    ).rejects.toThrow(/disabled/i);
  });

  it("cancels continuation from the invocation signal, including an already-aborted signal", async () => {
    const root = mkdtempSync(join(tmpdir(), "profiles-sessions-"));
    const session = join(root, "task.jsonl");
    writeFileSync(session, "{}");
    const runner = vi.fn(
      ({ signal }: any) =>
        new Promise<any>((_, reject) =>
          signal.addEventListener(
            "abort",
            () => reject(new Error(String(signal.reason))),
            { once: true },
          ),
        ),
    );
    const manager = managerWithRunner(runner);
    (manager as any).dependencies.continuationRoot = () => root;
    (manager as any).tasks.set("task", {
      id: "task",
      agent: "worker",
      task: "x",
      parentSessionId: "parent",
      status: "completed",
      createdAt: "now",
      nestedSessionPath: session,
      definition,
      controller: new AbortController(),
      messages: [],
    });
    const controller = new AbortController();
    const continuing = manager.continue(
      "task",
      "parent",
      "again",
      context,
      controller.signal,
    );
    controller.abort("caller cancelled");
    await expect(continuing).resolves.toMatchObject({
      status: "cancelled",
      error: "caller cancelled",
    });
    const aborted = new AbortController();
    aborted.abort("already cancelled");
    await expect(
      manager.continue("task", "parent", "again", context, aborted.signal),
    ).resolves.toMatchObject({
      status: "cancelled",
      error: "already cancelled",
    });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("continues in explicit task or background mode and notifies the background attempt once", async () => {
    vi.useFakeTimers();
    try {
    const root = mkdtempSync(join(tmpdir(), "profiles-sessions-"));
    const session = join(root, "task.jsonl");
    writeFileSync(session, "{}");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = managerWithRunner(async (input) => {
      if (input.continuationPrompt) await gate;
      return { result: "done", nestedSessionPath: session };
    });
    (manager as any).dependencies.continuationRoot = () => root;
    (manager as any).tasks.set("task", {
      id: "task",
      agent: "worker",
      task: "x",
      parentSessionId: "parent",
      status: "completed",
      mode: "task",
      createdAt: "now",
      nestedSessionPath: session,
      definition,
      controller: new AbortController(),
      messages: [],
    });
    const notices: string[] = [];
    manager.bindNotifier((notice) => {
      notices.push(notice);
    });
    const progress = vi.fn();
    const background: any = await manager.continue(
      "task",
      "parent",
      "again",
      context,
      undefined,
      "background",
      progress,
    );
    expect(background).toMatchObject({
      mode: "background",
      taskIds: ["task"],
      results: [],
    });
    await vi.advanceTimersByTimeAsync(550);
    expect(progress).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(notices).toHaveLength(1));
    await expect(
      manager.continue("task", "parent", "again", context, undefined, "task"),
    ).resolves.toMatchObject({ status: "completed", mode: "task" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("defaults continuation on, preserves attempts, and inherits prior background mode", async () => {
    const root = mkdtempSync(join(tmpdir(), "profiles-sessions-"));
    const session = join(root, "task.jsonl");
    writeFileSync(session, "{}");
    const runner = vi.fn(async (input) => ({
      result: input.continuationPrompt ? "continued" : "first",
      nestedSessionPath: session,
    }));
    const manager = new ForegroundTaskManager({
      runner: { run: runner },
      catalog: {
        discover: () => ({
          catalog: [definition],
          definitions: { worker: definition },
          diagnostics: [],
        }),
      },
      routePort: { resolveAgentRoute: () => undefined },
      config: {
        globalModelProfiles: {},
        projectModelProfiles: {},
        diagnostics: [],
      },
      continuationRoot: () => root,
    });
    const notices: string[] = [];
    manager.bindNotifier((notice) => {
      notices.push(notice);
    });
    const first = await manager.run(
      { agent: "worker", task: "work", mode: "background" },
      context,
    );
    await vi.waitFor(() =>
      expect(manager.status(first.taskIds[0], "parent")?.status).toBe(
        "completed",
      ),
    );
    const continued: any = await manager.continue(
      first.taskIds[0],
      "parent",
      "again",
      context,
    );
    expect(continued).toMatchObject({
      mode: "background",
      taskIds: [first.taskIds[0]],
      results: [],
    });
    await vi.waitFor(() =>
      expect(manager.status(first.taskIds[0], "parent")).toMatchObject({
        status: "completed",
        mode: "background",
        attempt: 2,
        result: "continued",
      }),
    );
    expect(runner.mock.calls[1][0]).toMatchObject({
      reopenPath: session,
      continuationPrompt: "again",
    });
    expect(notices).toHaveLength(2);
  });

  it("keeps background launch content to IDs and count before its eventual result", async () => {
    let finish!: () => void;
    const eventual = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const manager = managerWithRunner(async () => {
      await eventual;
      return { result: "SENTINEL_BACKGROUND_RESULT" };
    });
    const tools = createForegroundTools(
      () => manager,
      () => context,
      "subagent_",
    );
    const launch: any = await tools
      .find((tool) => tool.name === "subagent_run")!
      .execute(
        "",
        { agent: "worker", task: "work", mode: "background" },
        new AbortController().signal,
        undefined,
        { sessionManager: { getSessionId: () => "parent" } },
      );
    const content = launch.content.map((item: any) => item.text).join("\n");
    expect(content).toMatch(
      /Started 1 background subagent task: subtask_worker_/,
    );
    expect(content).not.toContain("SENTINEL_BACKGROUND_RESULT");
    expect(JSON.stringify(launch.details)).not.toContain(
      "SENTINEL_BACKGROUND_RESULT",
    );
    finish();
    await vi.waitFor(() =>
      expect(manager.status(launch.details.taskIds[0], "parent")?.status).toBe(
        "completed",
      ),
    );
  });

  it("keeps internals out of tool projections while returning foreground results in content", async () => {
    const root = mkdtempSync(join(tmpdir(), "profiles-sessions-"));
    const session = join(root, "task.jsonl");
    writeFileSync(session, "{}");
    const privateDefinition = {
      ...definition,
      filePath: "/local/SECRET_INTERNAL_PATH.md",
      instructions: "SECRET_INTERNAL_INSTRUCTIONS",
    };
    const path = join(
      mkdtempSync(join(tmpdir(), "profiles-history-")),
      "history.sqlite",
    );
    const history = new RuntimeHistory(path);
    const runner = vi.fn(async (input) => ({
      result: input.continuationPrompt
        ? "SENTINEL_RESULT_CONTINUE"
        : "SENTINEL_RESULT_RUN",
      nestedSessionPath: session,
    }));
    const catalog = {
      discover: () => ({
        catalog: [privateDefinition],
        definitions: { worker: privateDefinition },
        diagnostics: [],
      }),
    };
    const firstManager = new ForegroundTaskManager({
      runner: { run: runner },
      catalog,
      routePort: { resolveAgentRoute: () => undefined },
      config: {
        globalModelProfiles: {},
        projectModelProfiles: {},
        diagnostics: [],
      },
      history,
      continuationRoot: () => root,
    });
    const progress: unknown[] = [];
    const first = await firstManager.run(
      { agent: "worker", task: "work" },
      context,
      (tasks) => progress.push(tasks),
    );
    const id = first.taskIds[0];
    const tools = createForegroundTools(
      () => firstManager,
      () => context,
      "subagent_",
    );
    const toolContext = { sessionManager: { getSessionId: () => "parent" } };
    const outputs = [
      first,
      ...progress,
      firstManager.status(id, "parent"),
      firstManager.result(id, "parent"),
      firstManager.list("parent"),
    ];
    const toolResult = await tools
      .find((tool) => tool.name === "subagent_result")!
      .execute(
        "",
        { task_id: id },
        new AbortController().signal,
        undefined,
        toolContext,
      );
    const toolRun = await tools
      .find((tool) => tool.name === "subagent_run")!
      .execute(
        "",
        { agent: "worker", task: "tool work" },
        new AbortController().signal,
        (update: unknown) => outputs.push(update),
        toolContext,
      );
    const toolContinue = await tools
      .find((tool) => tool.name === "subagent_continue")!
      .execute(
        "",
        { task_id: id, prompt: "again" },
        new AbortController().signal,
        undefined,
        toolContext,
      );
    outputs.push(
      toolResult,
      toolRun,
      toolContinue,
      await tools
        .find((tool) => tool.name === "subagent_status")!
        .execute(
          "",
          { task_id: id },
          new AbortController().signal,
          undefined,
          toolContext,
        ),
      await tools
        .find((tool) => tool.name === "subagent_list_tasks")!
        .execute("", {}, new AbortController().signal, undefined, toolContext),
    );
    const content = (output: any) =>
      output.content.map((item: any) => item.text).join("\n");
    expect(content(toolRun)).toContain("SENTINEL_RESULT_RUN");
    expect(content(toolResult)).toContain("SENTINEL_RESULT_RUN");
    expect(content(toolContinue)).toContain("SENTINEL_RESULT_CONTINUE");
    for (const output of outputs)
      expect(JSON.stringify(output)).not.toMatch(
        /SECRET_INTERNAL_INSTRUCTIONS|SECRET_INTERNAL_PATH|nestedSessionPath|parentSessionId|definition/,
      );
    const db = new DatabaseSync(path);
    expect(
      String(
        (
          db
            .prepare("SELECT data FROM runtime_tasks WHERE id = ?")
            .get(id) as any
        ).data,
      ),
    ).not.toMatch(
      /SECRET_INTERNAL_INSTRUCTIONS|SECRET_INTERNAL_PATH|"definition"/,
    );
    db.close();
    history.close();
    const restarted = new RuntimeHistory(path);
    const unavailableManager = new ForegroundTaskManager({
      runner: { run: runner },
      catalog: {
        discover: () => ({ catalog: [], definitions: {}, diagnostics: [] }),
      },
      routePort: { resolveAgentRoute: () => undefined },
      config: {
        globalModelProfiles: {},
        projectModelProfiles: {},
        diagnostics: [],
      },
      history: restarted,
      continuationRoot: () => root,
    });
    await expect(
      unavailableManager.continue(id, "parent", "again", context),
    ).rejects.toThrow(/no longer available.*current trusted catalog/i);
    const secondManager = new ForegroundTaskManager({
      runner: { run: runner },
      catalog,
      routePort: { resolveAgentRoute: () => undefined },
      config: {
        globalModelProfiles: {},
        projectModelProfiles: {},
        diagnostics: [],
      },
      history: restarted,
      continuationRoot: () => root,
    });
    await expect(
      secondManager.continue(id, "parent", "again", context),
    ).resolves.toMatchObject({
      status: "completed",
      result: "SENTINEL_RESULT_CONTINUE",
      attempt: 3,
    });
    expect(runner.mock.calls.at(-1)![0].definition.instructions).toBe(
      "SECRET_INTERNAL_INSTRUCTIONS",
    );
    restarted.close();
  });

  it("rejects a symlink continuation that escapes the owned root", async () => {
    const root = mkdtempSync(join(tmpdir(), "profiles-sessions-"));
    const outside = join(
      mkdtempSync(join(tmpdir(), "profiles-outside-")),
      "outside.jsonl",
    );
    writeFileSync(outside, "{}");
    const link = join(root, "escape.jsonl");
    symlinkSync(outside, link);
    const manager = managerWithRunner(async () => ({ result: "done" }));
    (manager as any).dependencies.continuationRoot = () => root;
    (manager as any).tasks.set("task", {
      id: "task",
      agent: "worker",
      task: "x",
      parentSessionId: "parent",
      status: "completed",
      createdAt: "now",
      nestedSessionPath: link,
      definition,
      controller: new AbortController(),
      messages: [],
    });
    await expect(
      manager.continue("task", "parent", "again", context),
    ).rejects.toThrow(/outside/i);
  });
});
