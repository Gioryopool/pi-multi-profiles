import { beforeEach, describe, expect, it, vi } from "vitest";

const globalConfig = vi.hoisted(() => ({
  value: { version: 1, shortcut: "ctrl+shift+p", profiles: {} },
}));
const discovery = vi.hoisted(() => ({
  discover: (..._args: any[]) => ({
    catalog: [] as any[],
    definitions: {},
    diagnostics: [] as any[],
  }),
}));
const runtimeConfig = vi.hoisted(() => ({
  value: {
    globalModelProfiles: {},
    projectModelProfiles: {},
    diagnostics: [],
    backgroundHandoffShortcut: "ctrl+h",
  },
}));
const filesystem = vi.hoisted(() => ({
  exists: (_path: string): boolean => false,
}));

vi.mock("node:fs", () => ({
  existsSync: (path: string) => filesystem.exists(path),
  readFileSync: () => JSON.stringify(globalConfig.value),
  readdirSync: () => [],
}));
vi.mock("../src/subagents-runtime/discovery.js", () => ({
  internalAgentCatalog: {
    discover: (...args: any[]) => discovery.discover(...args),
  },
  readCompatibleSubagentsConfig: () => runtimeConfig.value,
}));

import extension from "../src/extension.js";

function fakePi() {
  const commands = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  const shortcutRegistrations: string[] = [];
  const lifecycle = new Map<string, any>();
  const listeners = new Map<string, (value: unknown) => void>();
  let disposed = 0;
  const tools = new Map<string, any>();
  const messageRenderers = new Map<string, any>();

  return {
    commands,
    shortcuts,
    shortcutRegistrations,
    lifecycle,
    listeners,
    tools,
    messageRenderers,
    get disposed() {
      return disposed;
    },
    events: {
      on(name: string, handler: (value: unknown) => void) {
        listeners.set(name, handler);
        return () => {
          disposed++;
          listeners.delete(name);
        };
      },
      emit(name: string, value: unknown) {
        listeners.get(name)?.(value);
      },
    },
    on(name: string, handler: any) {
      lifecycle.set(name, handler);
    },
    registerCommand(name: string, options: any) {
      commands.set(name, options);
    },
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerMessageRenderer(type: string, renderer: any) {
      messageRenderers.set(type, renderer);
    },
    registerShortcut(key: string, options: any) {
      shortcutRegistrations.push(key);
      shortcuts.set(key, options);
    },
    appendEntry() {},
    getThinkingLevel: () => "low",
    setThinkingLevel() {},
    setModel: async () => true,
  };
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    cwd: "/work",
    isProjectTrusted: () => false,
    model: { provider: "old", id: "one" },
    thinkingLevel: "low",
    sessionManager: { getSessionId: () => "session", getBranch: () => [] },
    modelRegistry: { find: () => undefined, getAvailable: () => [] },
    ui: {
      notify() {},
      setStatus() {},
      select: async () => undefined,
      input: async () => undefined,
      confirm: async () => false,
    },
    ...overrides,
  } as any;
}

describe("real Pi extension registration", () => {
  beforeEach(() => {
    delete (globalThis as any)[
      Symbol.for("pi.agent-profiles.subagents-runtime.v1")
    ];
    globalConfig.value = { version: 1, shortcut: "ctrl+shift+p", profiles: {} };
    filesystem.exists = () => false;
  });

  it("registers exactly eight canonical tools when Joker is absent", () => {
    const pi = fakePi();
    extension(pi as any);
    expect([...pi.tools.keys()]).toEqual([
      "subagent_list_agents",
      "subagent_run",
      "subagent_status",
      "subagent_result",
      "subagent_list_tasks",
      "subagent_cancel",
      "subagent_send_message",
      "subagent_continue",
    ]);
    expect(
      [...pi.tools.keys()].filter((name) =>
        name.startsWith("agent_profiles_subagent_"),
      ),
    ).toHaveLength(0);
    for (const registered of pi.tools.values())
      expect(registered.renderResult).toEqual(expect.any(Function));
    expect(pi.tools.get("subagent_run").renderCall).toEqual(
      expect.any(Function),
    );
  });

  it("registers exactly eight namespaced tools when Joker is installed", () => {
    filesystem.exists = (path) =>
      path.endsWith("/npm/node_modules/pi-subagents-j0k3r/package.json");
    const pi = fakePi();
    extension(pi as any);
    expect([...pi.tools.keys()]).toEqual([
      "agent_profiles_subagent_list_agents",
      "agent_profiles_subagent_run",
      "agent_profiles_subagent_status",
      "agent_profiles_subagent_result",
      "agent_profiles_subagent_list_tasks",
      "agent_profiles_subagent_cancel",
      "agent_profiles_subagent_send_message",
      "agent_profiles_subagent_continue",
    ]);
    expect(
      [...pi.tools.keys()].filter((name) => name.startsWith("subagent_")),
    ).toHaveLength(0);
    expect(pi.tools.get("agent_profiles_subagent_run").renderCall).toEqual(
      expect.any(Function),
    );
  });

  it("uses namespaced tools for a synchronous compatible catalog responder", () => {
    const pi = fakePi();
    pi.events.emit = (name: string, request: any) => {
      if (name === "pi-subagents:agents:v1") request.setAgents([]);
    };
    extension(pi as any);
    expect([...pi.tools.keys()]).toHaveLength(8);
    expect(
      [...pi.tools.keys()].every((name) =>
        name.startsWith("agent_profiles_subagent_"),
      ),
    ).toBe(true);
  });

  it("uses namespaced tools and one warning when ownership conflicts", async () => {
    (globalThis as any)[Symbol.for("pi.agent-profiles.subagents-runtime.v1")] =
      { id: "other-runtime" };
    const pi = fakePi();
    const notifications: any[] = [];
    extension(pi as any);
    expect([...pi.tools.keys()]).toHaveLength(8);
    expect([...pi.tools.keys()][0]).toMatch(/^agent_profiles_subagent_/);
    const ctx = context({
      ui: {
        notify: (...notice: any[]) => notifications.push(notice),
        setStatus() {},
        select: async () => undefined,
        input: async () => undefined,
        confirm: async () => false,
      },
    });
    await pi.lifecycle.get("session_start")({}, ctx);
    await pi.lifecycle.get("session_start")({}, ctx);
    expect(
      notifications.filter((notice) =>
        String(notice[0]).includes(
          "registered with the agent_profiles_subagent_ namespace",
        ),
      ),
    ).toHaveLength(1);
  });

  it("registers /subagents and the global alt+o history shortcut", () => {
    const pi = fakePi();
    extension(pi as any);
    expect(pi.commands.get("subagents")).toMatchObject({
      description: expect.stringMatching(/history/i),
      handler: expect.any(Function),
    });
    expect(pi.shortcuts.get("alt+o")).toMatchObject({
      description: expect.stringMatching(/history/i),
      handler: expect.any(Function),
    });
  });

  it("invokes the real-shaped custom overlay from both history entry points and routes input/close", async () => {
    const pi = fakePi();
    const cancel = vi.fn(() => true);
    const rendered: string[] = [];
    const runtime = {
      list: vi.fn(() => [
        {
          id: "queued",
          agent: "worker",
          task: "work",
          status: "queued",
          createdAt: "now",
        },
      ]),
      thread: vi.fn(() => ({
        entries: [{ role: "assistant", text: "response" }],
      })),
      cancel,
      updateConfig: vi.fn(),
      bindNotifier: vi.fn(),
    };
    extension(pi as any, { runtimeManagerFactory: () => runtime as any });
    const ui = {
      notify: vi.fn(),
      setStatus() {},
      select: async () => undefined,
      input: async () => undefined,
      confirm: async () => false,
      custom: async (factory: any) => {
        const component = factory(
          { requestRender() {} },
          undefined,
          undefined,
          () => {},
        );
        rendered.push(...component.render(90));
        component.handleInput("x");
        component.handleInput("q");
      },
    };
    const ctx = context({ ui });
    await pi.lifecycle.get("session_start")({}, ctx);
    await pi.commands.get("subagents").handler("", ctx);
    pi.shortcuts.get("alt+o").handler(ctx);
    await Promise.resolve();
    await Promise.resolve();
    expect(rendered.join("\n")).toContain("response");
    expect(cancel).toHaveBeenCalledWith("queued", "session");
    expect(ui.notify).not.toHaveBeenCalledWith(
      expect.stringMatching(/unavailable/),
      "error",
    );
  });

  it("registers migrated default shortcuts exactly once while preserving profile-cycle behavior", async () => {
    globalConfig.value = {
      version: 1,
      shortcut: "ctrl+tab",
      profiles: {},
    } as any;
    const pi = fakePi();
    extension(pi as any);

    expect(pi.shortcuts.get("alt+p")).toMatchObject({
      description: "Cycle agent profile",
      handler: expect.any(Function),
    });
    expect(pi.shortcuts.get("alt+o")).toMatchObject({
      description: "Browse subagent history",
      handler: expect.any(Function),
    });
    expect(
      pi.shortcutRegistrations.filter((key) => key === "alt+p"),
    ).toHaveLength(1);
    expect(
      pi.shortcutRegistrations.filter((key) => key === "alt+o"),
    ).toHaveLength(1);
    globalConfig.value = { version: 1, shortcut: "ctrl+shift+p", profiles: {} };
  });

  it("uses factory-only Pi and initializes from session_start context", async () => {
    const pi = fakePi();
    extension(pi as any);

    expect(pi.commands.get("agent-profiles")).toMatchObject({
      description: expect.any(String),
      handler: expect.any(Function),
    });
    expect(pi.shortcuts.get("ctrl+shift+p")).toMatchObject({
      handler: expect.any(Function),
    });
    await pi.lifecycle.get("session_start")(
      { type: "session_start", reason: "startup" },
      context(),
    );
  });

  it("uses a trusted project handoff override through exact terminal input, not the registered default", async () => {
    runtimeConfig.value = {
      globalModelProfiles: {},
      projectModelProfiles: {},
      diagnostics: [],
      backgroundHandoffShortcut: "ctrl+h",
    };
    const pi = fakePi();
    const handoff = vi.fn(() => true);
    extension(
      pi as any,
      {
        runtimeManagerFactory: () => ({
          handoff,
          updateConfig: vi.fn(),
          bindNotifier: vi.fn(),
        }),
      } as any,
    );
    runtimeConfig.value = {
      globalModelProfiles: {},
      projectModelProfiles: {},
      diagnostics: [],
      backgroundHandoffShortcut: "ctrl+g",
    };
    let terminalHandler: ((data: string) => unknown) | undefined;
    const ctx = context({
      isProjectTrusted: () => true,
      ui: {
        notify() {},
        setStatus() {},
        select: async () => undefined,
        input: async () => undefined,
        confirm: async () => false,
        onTerminalInput(handler: (data: string) => unknown) {
          terminalHandler = handler;
          return () => {};
        },
      },
    });
    await pi.lifecycle.get("session_start")({}, ctx);
    expect(pi.shortcuts.has("ctrl+h")).toBe(true);
    pi.shortcuts.get("ctrl+h").handler(ctx);
    expect(handoff).not.toHaveBeenCalled();
    terminalHandler?.("\u0007");
    expect(handoff).toHaveBeenCalledTimes(1);
    runtimeConfig.value = {
      globalModelProfiles: {},
      projectModelProfiles: {},
      diagnostics: [],
      backgroundHandoffShortcut: "ctrl+h",
    };
  });

  it("installs and disposes the supported terminal input handler per session", async () => {
    const pi = fakePi();
    const cancelOnDoubleEscape = vi.fn();
    const dispose = vi.fn();
    let terminalHandler: ((data: string) => unknown) | undefined;
    extension(
      pi as any,
      {
        runtimeManagerFactory: () => ({
          updateConfig: vi.fn(),
          bindNotifier: vi.fn(),
          cancelOnDoubleEscape,
        }),
      } as any,
    );
    const ctx = context({
      ui: {
        notify() {},
        setStatus() {},
        select: async () => undefined,
        input: async () => undefined,
        confirm: async () => false,
        onTerminalInput(handler: (data: string) => unknown) {
          terminalHandler = handler;
          return dispose;
        },
      },
    });
    await pi.lifecycle.get("session_start")({}, ctx);
    expect(terminalHandler).toEqual(expect.any(Function));
    terminalHandler?.("\u001b");
    expect(cancelOnDoubleEscape).toHaveBeenCalledOnce();
    await pi.lifecycle.get("session_shutdown")({}, ctx);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("does not read persisted history for character, backspace, or widget navigation input", async () => {
    const pi = fakePi();
    const list = vi.fn(() => [
      {
        id: "background",
        agent: "worker",
        task: "work",
        parentSessionId: "session",
        mode: "background",
        status: "running",
        createdAt: "now",
      },
    ]);
    const backgroundTasks = vi.fn(() => [
      {
        id: "background",
        agent: "worker",
        mode: "background",
        status: "running",
        liveActivity: { trail: [] },
      },
    ]);
    let terminalHandler: ((data: string) => unknown) | undefined;
    extension(
      pi as any,
      {
        runtimeManagerFactory: () => ({
          list,
          backgroundTasks,
          updateConfig: vi.fn(),
          bindNotifier: vi.fn(),
          bindActivityListener: vi.fn(),
        }),
      } as any,
    );
    const ctx = context({
      ui: {
        notify() {},
        setStatus() {},
        select: async () => undefined,
        input: async () => undefined,
        confirm: async () => false,
        onTerminalInput(handler: (data: string) => unknown) {
          terminalHandler = handler;
          return () => {};
        },
      },
    });
    await pi.lifecycle.get("session_start")({}, ctx);
    list.mockClear();
    terminalHandler?.("a");
    terminalHandler?.("\u007f");
    terminalHandler?.("\u001b[B");
    expect(list).not.toHaveBeenCalled();
    expect(backgroundTasks).toHaveBeenCalledTimes(3);
  });

  it("cancels and removes the exact session runtime manager on shutdown", async () => {
    const pi = fakePi();
    const cancelSession = vi.fn();
    const dispose = vi.fn((sessionId: string) => cancelSession(sessionId));
    const runtimeManager = {
      run: vi.fn(async () => ({ results: [] })),
      dispose,
      cancelSession,
    };
    extension(
      pi as any,
      { runtimeManagerFactory: () => runtimeManager } as any,
    );
    const ctx = context();
    await pi.lifecycle.get("session_start")({}, ctx);
    const run = pi.tools.get("subagent_run");
    const activeRun = await run.execute(
      "",
      { agent: "a", task: "work" },
      new AbortController().signal,
      undefined,
      ctx,
    );
    expect(activeRun).not.toHaveProperty("isError");
    pi.lifecycle.get("session_shutdown")({}, ctx);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(cancelSession).toHaveBeenCalledWith("session");
    await expect(
      run.execute(
        "",
        { agent: "a", task: "work" },
        new AbortController().signal,
        undefined,
        ctx,
      ),
    ).resolves.toMatchObject({ isError: true });
  });

  it("uses the exact Pi follow-up notifier contract", async () => {
    const pi = fakePi();
    const sendMessage = vi.fn();
    (pi as any).sendMessage = sendMessage;
    let notifier: ((task: any) => void) | undefined;
    extension(
      pi as any,
      {
        runtimeManagerFactory: () => ({
          run: vi.fn(),
          updateConfig: vi.fn(),
          bindCompletionNotifier: (value: (task: any) => void) => {
            notifier = value;
          },
        }),
      } as any,
    );
    await pi.lifecycle.get("session_start")({}, context());
    notifier?.({
      id: "task",
      agent: "worker",
      status: "completed",
      mode: "background",
      result: "complete",
    });
    expect(
      pi.messageRenderers.get("pi-agent-profiles:subagent-complete"),
    ).toEqual(expect.any(Function));
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(
      {
        customType: "pi-agent-profiles:subagent-complete",
        content: expect.stringContaining("complete"),
        details: {
          task: {
            id: "task",
            agent: "worker",
            status: "completed",
            mode: "background",
            attempt: undefined,
          },
          result: "complete",
        },
        display: true,
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  });

  it("keeps shared runtime resources alive until the final of two session shutdowns", async () => {
    const pi = fakePi();
    const close = vi.fn();
    const historyFactory = vi.fn(() => ({ close }));
    const shutdown = vi.fn(async () => {});
    const runtimeManagerFactory = vi.fn(() => ({
      run: vi.fn(async () => ({ mode: "task", taskIds: [], results: [] })),
      shutdown,
      updateConfig: vi.fn(),
      bindNotifier: vi.fn(),
    }));
    extension(
      pi as any,
      { runtimeManagerFactory, runtimeHistoryFactory: historyFactory } as any,
    );
    const a = context({
      sessionManager: { getSessionId: () => "A", getBranch: () => [] },
    });
    const b = context({
      sessionManager: { getSessionId: () => "B", getBranch: () => [] },
    });
    await pi.lifecycle.get("session_start")({}, a);
    await pi.lifecycle.get("session_start")({}, b);
    expect(historyFactory).toHaveBeenCalledTimes(1);
    expect(runtimeManagerFactory).toHaveBeenCalledTimes(2);
    await pi.lifecycle.get("session_shutdown")({}, a);
    expect(shutdown).toHaveBeenCalledWith("A");
    expect(close).not.toHaveBeenCalled();
    expect(pi.disposed).toBe(0);
    await expect(
      pi.tools
        .get("subagent_run")
        .execute(
          "",
          { agent: "a", task: "work" },
          new AbortController().signal,
          undefined,
          b,
        ),
    ).resolves.not.toHaveProperty("isError");
    await pi.lifecycle.get("session_shutdown")({}, b);
    expect(shutdown).toHaveBeenCalledWith("B");
    expect(close).toHaveBeenCalledTimes(1);
    expect(pi.disposed).toBe(1);
  });

  it("reacquires runtime resources and the compatibility listener for a later session cycle", async () => {
    const pi = fakePi();
    const close = vi.fn();
    const historyFactory = vi.fn(() => ({ close }));
    const runtimeManagerFactory = vi.fn(() => ({
      run: vi.fn(async () => ({ mode: "task", taskIds: [], results: [] })),
      shutdown: vi.fn(async () => {}),
      updateConfig: vi.fn(),
      bindNotifier: vi.fn(),
    }));
    extension(
      pi as any,
      { runtimeManagerFactory, runtimeHistoryFactory: historyFactory } as any,
    );
    const a = context({
      sessionManager: { getSessionId: () => "A", getBranch: () => [] },
    });
    const b = context({
      sessionManager: {
        getSessionId: () => "B",
        getBranch: () => [
          {
            type: "custom",
            customType: "pi-agent-profiles:active",
            data: {
              profile: "p",
              route: {},
              defaultRoute: { effort: "high" },
              agents: {},
              baseline: {},
              activatedAt: "now",
            },
          },
        ],
      },
    });
    await pi.lifecycle.get("session_start")({}, a);
    await pi.lifecycle.get("session_shutdown")({}, a);
    expect(close).toHaveBeenCalledTimes(1);
    expect(pi.disposed).toBe(1);
    await pi.lifecycle.get("session_start")({}, b);
    expect(historyFactory).toHaveBeenCalledTimes(2);
    expect(runtimeManagerFactory).toHaveBeenCalledTimes(2);
    expect(pi.listeners.has("pi-subagents:model-route:v1")).toBe(true);
    let route: unknown;
    pi.listeners.get("pi-subagents:model-route:v1")?.({
      version: 1,
      cwd: "/work",
      agent: "worker",
      sessionId: "B",
      setRoute(value: unknown) {
        route = value;
      },
    });
    expect(route).toEqual({ effort: "high" });
    await expect(
      pi.tools
        .get("subagent_run")
        .execute(
          "",
          { agent: "a", task: "work" },
          new AbortController().signal,
          undefined,
          b,
        ),
    ).resolves.not.toHaveProperty("isError");
    await pi.lifecycle.get("session_shutdown")({}, b);
    expect(close).toHaveBeenCalledTimes(2);
    expect(pi.disposed).toBe(2);
  });

  it("starts and stops without Joker or a model prompt", async () => {
    const pi = fakePi();
    const prompt = vi.fn();
    const setModel = vi.fn();
    (pi as any).setModel = setModel;
    (pi as any).prompt = prompt;
    extension(pi as any);
    const ctx = context({ model: undefined });
    await pi.lifecycle.get("session_start")({}, ctx);
    await pi.lifecycle.get("session_shutdown")({}, ctx);
    expect([...pi.tools.keys()]).toHaveLength(8);
    expect(prompt).not.toHaveBeenCalled();
    expect(setModel).not.toHaveBeenCalled();
  });

  it("waits for concurrent final session shutdowns before closing shared history", async () => {
    const pi = fakePi();
    const close = vi.fn();
    let releaseA!: () => void;
    let releaseB!: () => void;
    const waitA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const waitB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    const runtimeManagerFactory = vi.fn(() => ({
      run: vi.fn(),
      updateConfig: vi.fn(),
      bindNotifier: vi.fn(),
      shutdown: vi.fn((sessionId: string) =>
        sessionId === "A" ? waitA : waitB,
      ),
    }));
    extension(
      pi as any,
      {
        runtimeManagerFactory,
        runtimeHistoryFactory: () => ({ close }),
      } as any,
    );
    const a = context({
      sessionManager: { getSessionId: () => "A", getBranch: () => [] },
    });
    const b = context({
      sessionManager: { getSessionId: () => "B", getBranch: () => [] },
    });
    await pi.lifecycle.get("session_start")({}, a);
    await pi.lifecycle.get("session_start")({}, b);
    const shutdownA = pi.lifecycle.get("session_shutdown")({}, a);
    const shutdownB = pi.lifecycle.get("session_shutdown")({}, b);
    releaseA();
    await shutdownA;
    expect(close).not.toHaveBeenCalled();
    releaseB();
    await shutdownB;
    expect(close).toHaveBeenCalledTimes(1);
    expect(pi.disposed).toBe(1);
  });

  it("routes only a synchronous exact-session request after lifecycle restore", async () => {
    const pi = fakePi();
    extension(pi as any);
    const ctx = context({
      sessionManager: {
        getSessionId: () => "session",
        getBranch: () => [
          {
            type: "custom",
            customType: "pi-agent-profiles:active",
            data: {
              profile: "p",
              route: {},
              defaultRoute: { effort: "high" },
              agents: {},
              baseline: {},
              activatedAt: "now",
            },
          },
        ],
      },
    });

    await pi.lifecycle.get("session_start")(
      { type: "session_start", reason: "resume" },
      ctx,
    );
    let route: unknown;
    pi.listeners.get("pi-subagents:model-route:v1")?.({
      version: 1,
      cwd: "/work",
      agent: "a",
      sessionId: "session",
      setRoute(value: unknown) {
        route = value;
      },
    });
    expect(route).toEqual({ effort: "high" });
  });

  it("passes only Joker v1-valid nonempty routes to setRoute", async () => {
    const pi = fakePi();
    extension(pi as any);
    const ctx = context({
      sessionManager: {
        getSessionId: () => "session",
        getBranch: () => [
          {
            type: "custom",
            customType: "pi-agent-profiles:active",
            data: {
              profile: "p",
              route: {},
              defaultRoute: {
                model: { provider: "openai", id: "gpt-5" },
                effort: "high",
              },
              agents: { empty: {} },
              baseline: {},
              activatedAt: "now",
            },
          },
        ],
      },
    });

    await pi.lifecycle.get("session_start")(
      { type: "session_start", reason: "resume" },
      ctx,
    );
    const routes: any[] = [];
    const request = (agent: string) =>
      pi.listeners.get("pi-subagents:model-route:v1")?.({
        version: 1,
        cwd: "/work",
        agent,
        sessionId: "session",
        setRoute(route: unknown) {
          routes.push(route);
        },
      });

    request("unknown");
    request("empty");

    expect(routes).toEqual([
      { model: { provider: "openai", id: "gpt-5" }, effort: "high" },
    ]);
    for (const route of routes) {
      expect(route.model?.provider).toEqual(expect.any(String));
      expect(route.model?.provider).not.toBe("");
      expect(route.model?.id).toEqual(expect.any(String));
      expect(route.model?.id).not.toBe("");
      expect([
        "off",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]).toContain(route.effort);
    }
  });

  it("falls back from an invalid global shortcut and reports the diagnostic at session start", async () => {
    globalConfig.value = {
      version: 1,
      shortcut: "invalid shortcut!",
      profiles: {},
    };
    const pi = fakePi();
    const notifications: unknown[] = [];
    extension(pi as any);

    expect(pi.shortcuts.has("alt+p")).toBe(true);
    await pi.lifecycle.get("session_start")(
      { type: "session_start", reason: "startup" },
      context({
        ui: {
          notify: (...args: unknown[]) => notifications.push(args),
          setStatus() {},
          select: async () => undefined,
          input: async () => undefined,
          confirm: async () => false,
        },
      }),
    );
    expect(notifications.flat().join(" ")).toMatch(/shortcut/i);
    globalConfig.value = { version: 1, shortcut: "ctrl+shift+p", profiles: {} };
  });

  it("deduplicates internal discovery diagnostics and keeps a valid empty catalog authoritative", async () => {
    const pi = fakePi();
    const notifications: unknown[] = [];
    let eventCalls = 0;
    let agents: unknown;
    pi.events.emit = () => {
      eventCalls++;
    };
    discovery.discover = () => ({
      catalog: [],
      definitions: {},
      diagnostics: [
        { message: "bad definition", path: "/global/agents/bad.md" },
      ],
    });
    extension(pi as any);
    const ctx = context({
      ui: {
        notify: (...args: unknown[]) => notifications.push(args),
        setStatus() {},
        select: async () => undefined,
        input: async () => undefined,
        confirm: async () => false,
        custom: async (factory: any) => {
          agents = factory(
            { requestRender() {} },
            undefined,
            undefined,
            () => {},
          ).agents;
          return undefined;
        },
      },
    });
    await pi.commands.get("agent-profiles").handler("", ctx);
    await pi.commands.get("agent-profiles").handler("", ctx);
    expect(agents).toEqual([]);
    expect(eventCalls).toBe(1);
    expect(
      notifications.filter((notice) =>
        String((notice as any[])[0]).includes("bad definition"),
      ),
    ).toHaveLength(1);
    discovery.discover = () => ({
      catalog: [],
      definitions: {},
      diagnostics: [],
    });
  });

  it("falls back when internal discovery throws", async () => {
    const pi = fakePi();
    let agents: unknown;
    discovery.discover = () => {
      throw new Error("unavailable");
    };
    pi.events.emit = (_: string, request: any) =>
      request.setAgents([
        { name: "legacy", description: "fallback", scope: "global" },
      ]);
    extension(pi as any);
    const ctx = context({
      ui: {
        notify() {},
        setStatus() {},
        select: async () => undefined,
        input: async () => undefined,
        confirm: async () => false,
        custom: async (factory: any) => {
          agents = factory(
            { requestRender() {} },
            undefined,
            undefined,
            () => {},
          ).agents;
          return undefined;
        },
      },
    });
    await pi.commands.get("agent-profiles").handler("", ctx);
    expect(agents).toEqual([
      { name: "legacy", description: "fallback", scope: "global" },
    ]);
    discovery.discover = () => ({
      catalog: [],
      definitions: {},
      diagnostics: [],
    });
  });

  it("releases the event listener on shutdown so a rebound instance can register", () => {
    const pi = fakePi();
    extension(pi as any);

    pi.lifecycle.get("session_shutdown")({}, context());
    expect(pi.disposed).toBe(1);
    extension(pi as any);
    expect(pi.listeners.has("pi-subagents:model-route:v1")).toBe(true);
  });
});
