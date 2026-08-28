import { describe, expect, it, vi } from "vitest";
import { createForegroundTools } from "../../src/subagents-runtime/tools.js";
import { visibleWidth } from "../../src/subagents-runtime/render/text-width.js";

const theme = {
  fg: (_kind: string, value: string) => `\u001b[36m${value}\u001b[0m`,
  bold: (value: string) => `\u001b[1m${value}\u001b[0m`,
};
const render = (component: any, width: number) =>
  component.render(width).join("\n");
const stripAnsi = (value: string) =>
  value.replace(
    /\u001b\][^\u001b\u0007]*(?:\u001b\\|\u0007)|\u001b\[[0-?]*[ -/]*[@-~]/g,
    "",
  );
const tools = createForegroundTools(
  () => undefined,
  () => ({}),
  "subagent_",
);
const tool = (name: string): any =>
  tools.find((item) => item.name === `subagent_${name}`)!;
const result = (details: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: "model-visible final result" }],
  details,
  isError,
});
const task = {
  id: "subtask_worker_123456",
  agent: "worker",
  task: "review this",
  status: "completed",
  mode: "task",
  attempt: 2,
  model: { provider: "openai", id: "gpt-5" },
  effort: "high",
  usage: { input: 1234, output: 567 },
  result: "final response",
  instructions: "SECRET",
  filePath: "/secret",
  nestedSessionPath: "/nested",
  parentSessionId: "parent",
  attempts: [{ instructions: "SECRET" }],
};

describe("subagent tool renderers", () => {
  it("renders a compact colored run card at narrow and wide widths without internal fields", () => {
    const call = render(
      tool("run").renderCall!(
        { agent: "worker", task: "review this", mode: "task" },
        theme,
      ),
      80,
    );
    const narrow = render(
      tool("run").renderResult!(
        result({ results: [task] }),
        { expanded: false, isPartial: false } as any,
        theme,
      ),
      24,
    );
    const wide = render(
      tool("run").renderResult!(
        result({ results: [task] }),
        { expanded: true, isPartial: false } as any,
        theme,
      ),
      100,
    );
    expect(call).toMatch(/worker.*task/);
    expect(stripAnsi(call)).toContain("alt+o or /subagents for details");
    expect(narrow).toMatch(/completed|worker/);
    expect(narrow).toMatch(/response: collapsed|ctrl\+o/);
    expect(narrow).not.toMatch(
      /SECRET|instructions|filePath|nestedSessionPath|parentSessionId|attempts/,
    );
    expect(wide).toContain("final response");
    for (const line of narrow.split("\n"))
      expect(
        [
          ...line.replace(
            /\u001b\][^\u001b\u0007]*(?:\u001b\\|\u0007)|\u001b\[[0-?]*[ -/]*[@-~]/g,
            "",
          ),
        ].length,
      ).toBeLessThanOrEqual(24);
  });

  it("renders exact stripped final and collapsed task-list lines", () => {
    const run = stripAnsi(
      render(
        tool("run").renderResult!(
          result({ results: [task] }),
          { expanded: false, isPartial: false } as any,
          theme,
        ),
        200,
      ),
    );
    const continued = stripAnsi(
      render(
        tool("continue").renderResult!(
          result({ task }),
          { expanded: true, isPartial: false } as any,
          theme,
        ),
        200,
      ),
    );
    const subagentResult = stripAnsi(
      render(
        tool("result").renderResult!(
          result({ task: { ...task, undeliveredMessages: 0 } }),
          { expanded: false, isPartial: false } as any,
          theme,
        ),
        200,
      ),
    );
    const tasks = stripAnsi(
      render(
        tool("list_tasks").renderResult!(
          result(
            Array.from({ length: 6 }, (_, index) => ({
              ...task,
              id: `task-${index + 1}`,
            })),
          ),
          { expanded: false } as any,
          theme,
        ),
        200,
      ),
    );

    expect(run.split("\n").slice(0, 3)).toEqual([
      "agent: worker · status: completed · attempt: 2 · effort: high",
      "model: openai/gpt-5 · id: subtask_worker_123456",
      "usage: ↑1.2k ↓567",
    ]);
    expect(continued.split("\n").slice(0, 5)).toEqual([
      "agent: worker · status: completed · attempt: 2 · effort: high",
      "model: openai/gpt-5 · id: subtask_worker_123456",
      "usage: ↑1.2k ↓567",
      "Subagent response",
      "final response",
    ]);
    expect(subagentResult.split("\n").slice(0, 5)).toEqual([
      "Subagent result: worker · status: completed · id: subtask_worker_123456",
      "model: openai/gpt-5 · effort: high",
      "usage: ↑1.2k ↓567",
      "undelivered messages: 0",
      "response: collapsed · ctrl+o to expand · subagent_result subtask_worker_123456",
    ]);
    const resultWithoutUndelivered = stripAnsi(
      render(
        tool("result").renderResult!(
          result({ task }),
          { expanded: false, isPartial: false } as any,
          theme,
        ),
        200,
      ),
    );
    expect(resultWithoutUndelivered).not.toContain("undelivered messages:");
    expect(tasks.split("\n")).toEqual([
      "Listed 6 subagent task(s).",
      "List view: collapsed · ctrl+o to expand",
      "",
      "agent: worker · status: completed · attempt: 2 · id: task-1 · usage: ↑1.2k ↓567",
      "agent: worker · status: completed · attempt: 2 · id: task-2 · usage: ↑1.2k ↓567",
      "agent: worker · status: completed · attempt: 2 · id: task-3 · usage: ↑1.2k ↓567",
      "agent: worker · status: completed · attempt: 2 · id: task-4 · usage: ↑1.2k ↓567",
      "agent: worker · status: completed · attempt: 2 · id: task-5 · usage: ↑1.2k ↓567",
      "… 1 more task(s) hidden",
    ]);
  });

  it("renders partial, failure, and the five detail surfaces from compact details", () => {
    const partial = render(
      tool("run").renderResult!(
        result({ results: [{ ...task, status: "running" }] }),
        { expanded: false, isPartial: true } as any,
        theme,
      ),
      80,
    );
    const failure = render(
      tool("result").renderResult!(
        result({ task: { ...task, status: "failed", error: "nope" } }, true),
        { expanded: false, isPartial: false } as any,
        theme,
      ),
      80,
    );
    const continued = render(
      tool("continue").renderResult!(
        result({ task }),
        { expanded: false, isPartial: false } as any,
        theme,
      ),
      80,
    );
    const agents = render(
      tool("list_agents").renderResult!(
        result([{ name: "worker", description: "Does work", scope: "global" }]),
        { expanded: false } as any,
        theme,
      ),
      80,
    );
    const tasks = render(
      tool("list_tasks").renderResult!(
        result([task]),
        { expanded: false } as any,
        theme,
      ),
      80,
    );
    expect(partial).toMatch(/running|Starting/);
    expect(failure).toMatch(/failed/);
    expect(continued).toMatch(/completed/);
    expect(agents).toContain("worker");
    expect(tasks).toContain("worker");
  });

  it("gives namespaced tools the identical renderer behavior", () => {
    const alias: any = createForegroundTools(
      () => undefined,
      () => ({}),
      "agent_profiles_subagent_",
    ).find((item) => item.name === "agent_profiles_subagent_run")!;
    const aliasCall = render(
      alias.renderCall!(
        { agent: "worker", task: "x", mode: "background" },
        theme,
      ),
      80,
    );
    expect(aliasCall).toContain("/subagents for details");
    expect(aliasCall).not.toContain("agent_profiles_subagent_result");
    expect(aliasCall).toContain("worker");
  });

  it("renders direct task details produced by status, result, and continue executes", async () => {
    const direct = {
      ...task,
      usage: {
        turns: 2,
        input: 12_000,
        output: 400,
        cacheRead: 80,
        cacheWrite: 4,
        cost: 0.1234,
        contextTokens: 20_000,
      },
    };
    const manager: any = {
      status: () => direct,
      result: () => direct,
      continue: async () => direct,
    };
    const actual = createForegroundTools(
      () => manager,
      () => ({}),
      "subagent_",
    );
    const ctx = { sessionManager: { getSessionId: () => "parent" } };
    for (const name of ["status", "result", "continue"] as const) {
      const invoked = await actual
        .find((entry) => entry.name === `subagent_${name}`)!
        .execute(
          "",
          name === "continue"
            ? { task_id: direct.id, prompt: "again" }
            : { task_id: direct.id },
          new AbortController().signal,
          undefined,
          ctx,
        );
      const output = render(
        actual.find((entry) => entry.name === `subagent_${name}`)!
          .renderResult!(invoked, { expanded: false }, theme),
        120,
      );
      expect(output).not.toContain("No subagent details available"); // mutation/reversion guard for direct public details
      expect(stripAnsi(output)).toContain("worker");
      expect(output).toMatch(
        /usage:.*turns.*↑12k.*↓400.*R80.*W4.*\$0\.1234.*ctx:20k/,
      );
    }
  });

  it("preserves continuation identity when package-owned session data is unavailable", async () => {
    const previous = { ...task, mode: "background", attempt: 4 };
    const status = vi.fn(() => previous);
    const manager: any = {
      status,
      continue: async () => {
        throw new Error(
          `Task ${task.id} cannot be continued because its package-owned session data is unavailable`,
        );
      },
    };
    const actual = createForegroundTools(
      () => manager,
      () => ({}),
      "subagent_",
    );
    const invoked = await actual
      .find((entry) => entry.name === "subagent_continue")!
      .execute(
        "",
        { task_id: task.id, prompt: "again" },
        new AbortController().signal,
        undefined,
        { sessionManager: { getSessionId: () => "parent" } },
      );
    const output = stripAnsi(
      render(
        actual.find((entry) => entry.name === "subagent_continue")!
          .renderResult!(invoked, { expanded: true }, theme),
        120,
      ),
    );
    expect(invoked).toMatchObject({
      isError: true,
      details: {
        id: task.id,
        agent: "worker",
        mode: "background",
        attempt: 4,
        status: "failed",
        error: expect.stringMatching(/session data is unavailable/i),
      },
    });
    expect(status).toHaveBeenCalledWith(task.id, "parent");
    expect(output).toContain(`id: ${task.id}`);
    expect(output).toContain("agent: worker");
    expect(output).not.toContain("status: unknown");
    expect(output).not.toContain("id: unknown");
  });
  it("keeps requested continuation ids without prior status and does not turn generic errors into task cards", async () => {
    const manager: any = {
      status: () => undefined,
      continue: async () => {
        throw new Error("session data is unavailable");
      },
    };
    const actual = createForegroundTools(
      () => manager,
      () => ({}),
      "subagent_",
    );
    const invoked = await actual
      .find((entry) => entry.name === "subagent_continue")!
      .execute(
        "",
        { task_id: "requested-id", prompt: "again" },
        new AbortController().signal,
        undefined,
        { sessionManager: { getSessionId: () => "parent" } },
      );
    expect(invoked).toMatchObject({
      details: {
        id: "requested-id",
        status: "failed",
        error: "session data is unavailable",
      },
    });
    const generic = stripAnsi(
      render(
        tool("continue").renderResult!(
          result({ error: "boom" }, true),
          { expanded: true },
          theme,
        ),
        120,
      ),
    );
    expect(generic).toBe("model-visible final result");
    expect(generic).not.toMatch(/agent: subagent|status: unknown|id: unknown/);
  });

  it("increments partial spinner frames for task runs and continuations without changing finals", async () => {
    const running = { ...task, status: "running" };
    const manager: any = {
      run: async (_params: any, _context: any, progress: any) => {
        progress([running]);
        progress([running]);
        return { mode: "task", taskIds: [task.id], results: [task] };
      },
      continue: async (...args: any[]) => {
        const progress = args[6];
        progress([running]);
        progress([running]);
        return task;
      },
    };
    const actual = createForegroundTools(() => manager, () => ({}), "subagent_");
    const ctx = { sessionManager: { getSessionId: () => "parent" } };
    const updates: any[] = [];
    const run = actual.find((entry) => entry.name === "subagent_run")!;
    const final = await run.execute(
      "",
      { agent: "worker", task: "work" },
      new AbortController().signal,
      (update: any) => updates.push(update),
      ctx,
    );
    const continued: any[] = [];
    const continuation = actual.find((entry) => entry.name === "subagent_continue")!;
    const continuationFinal = await continuation.execute(
      "",
      { task_id: task.id, prompt: "again" },
      new AbortController().signal,
      (update: any) => continued.push(update),
      ctx,
    );
    const expectFrames = (partials: any[], renderer: any) => {
      expect(partials.map((update) => update.details.frame)).toEqual([0, 1]);
      expect(
        render(renderer.renderResult!(partials[0], { isPartial: true }, theme), 80),
      ).not.toBe(
        render(renderer.renderResult!(partials[1], { isPartial: true }, theme), 80),
      );
    };
    expectFrames(updates, run);
    expectFrames(continued, continuation);
    expect((final as any).details).toEqual({
      mode: "task",
      taskIds: [task.id],
      results: [task],
    });
    expect((continuationFinal as any).details).toEqual(task);
  });

  it("keeps partial metadata and ANSI/CJK/combining display widths safe", () => {
    const partialTask = {
      ...task,
      agent: "工人",
      task: "e\u0301 reviewing",
      status: "running",
      usage: { turns: 1, input: 1000 },
      backgroundable: true,
      backgroundShortcut: "ctrl+h",
    };
    const partial = render(
      tool("run").renderResult!(
        { content: [], details: partialTask },
        { isPartial: true },
        theme,
      ),
      80,
    );
    expect(partial).toMatch(/agent:.*工人.*status:.*running.*effort:.*high/s);
    expect(partial).toMatch(/usage:.*1 turn.*↑1\.0k/);
    expect(partial).toContain("ctrl+h to send to background");
    expect(visibleWidth("\u001b[31m工e\u0301\u001b[0m")).toBe(3);
    const narrow = tool("run").renderResult!(
      { content: [], details: { ...partialTask, result: "工人".repeat(20) } },
      { expanded: true },
      theme,
    ).render(9);
    for (const line of narrow)
      expect(visibleWidth(line)).toBeLessThanOrEqual(9);
  });
});
