import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveEffectiveRoute } from "./profile-resolver.js";
import { nestedSessionsRoot } from "./sdk-runner.js";
import { processSubagentEvent } from "./event-processing.js";
import { buildPublicTaskSnapshot } from "./snapshot-builder.js";
import { appendThreadEvent, sanitizeThreadSnapshot } from "./thread-view.js";
import type {
  AgentCatalogPort,
  AgentRoutePort,
  CompatibleSubagentsConfig,
  ForegroundRunner,
  ForegroundTask,
  LiveBridge,
  PublicForegroundTask,
  RuntimeAgentDefinition,
} from "./types.js";
import type { Route } from "../types.js";
import type { RuntimeHistory } from "./history.js";

type Input = {
  agent?: string;
  agents?: string[];
  task?: string;
  context?: string;
  mode?: "task" | "background";
};
type Context = {
  cwd: string;
  projectTrusted: boolean;
  sessionId: string;
  orchestrator: Route;
  ctx?: unknown;
  agentDir?: string;
  fs?: Parameters<AgentCatalogPort["discover"]>[0]["fs"];
};
type RuntimeTask = ForegroundTask & {
  definition: RuntimeAgentDefinition;
  controller: AbortController;
  bridge?: LiveBridge;
  messages: string[];
  draining?: Promise<boolean>;
  continuing?: boolean;
};
type Notifier = (message: string) => Promise<void> | void;
type CompletionNotifier = (task: PublicForegroundTask) => Promise<void> | void;
export type BackgroundWidgetTask = Pick<
  PublicForegroundTask,
  "id" | "agent" | "mode" | "status" | "liveActivity"
>;
type ActivityListener = () => void;
type Dependencies = {
  runner: ForegroundRunner;
  catalog: AgentCatalogPort;
  routePort: AgentRoutePort;
  config: CompatibleSubagentsConfig;
  history?: RuntimeHistory;
  notifier?: Notifier;
  continuationRoot?: () => string;
  continuationValidator?: (path: string) => void;
};
const normalize = (name: string) => name.trim().toLowerCase();
const now = () => new Date().toISOString();
const terminal = (status: ForegroundTask["status"]) =>
  ["completed", "failed", "cancelled", "interrupted"].includes(status);

export class ForegroundTaskManager {
  private readonly tasks = new Map<string, RuntimeTask>();
  private readonly runs = new Map<string, Promise<unknown>>();
  private readonly operations = new Map<string, Set<Promise<unknown>>>();
  private readonly handoffs = new Map<string, Set<() => void>>();
  private readonly escapePresses = new Map<string, number>();
  private readonly pendingRecords = new Map<string, ForegroundTask>();
  private readonly recordTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  /** Active widget state is memory-only so terminal input never hydrates history. */
  private readonly sessionTaskCache = new Map<string, BackgroundWidgetTask[]>();
  private notifier?: Notifier;
  private completionNotifier?: CompletionNotifier;
  private activityListener?: ActivityListener;
  constructor(private readonly dependencies: Dependencies) {
    this.notifier = dependencies.notifier;
  }
  updateConfig(config: CompatibleSubagentsConfig) {
    this.dependencies.config = config;
  }
  bindNotifier(notifier?: Notifier) {
    this.notifier = notifier;
  }
  bindCompletionNotifier(notifier?: CompletionNotifier) {
    this.completionNotifier = notifier;
  }
  /** Package UI observes exact-session state without polling or retaining runner listeners. */
  bindActivityListener(listener?: ActivityListener) {
    this.activityListener = listener;
  }
  private changed() {
    this.activityListener?.();
  }
  validate(input: Input): string[] {
    if ((input.agent === undefined) === (input.agents === undefined))
      throw new Error("Provide exactly one of agent or agents");
    if (typeof input.task !== "string" || !input.task.trim())
      throw new Error("Task must not be empty");
    if (input.task.length > 64_000)
      throw new Error("Task exceeds 64000 characters");
    const names = input.agent === undefined ? input.agents : [input.agent];
    if (
      !Array.isArray(names) ||
      !names.length ||
      !names.every((name) => typeof name === "string" && normalize(name))
    )
      throw new Error("Agents must be a nonempty list of names");
    const normalized = names.map(normalize);
    if (new Set(normalized).size !== normalized.length)
      throw new Error("Duplicate agents are not allowed");
    return normalized;
  }
  agents(context: Pick<Context, "cwd" | "projectTrusted" | "agentDir" | "fs">) {
    return this.dependencies.catalog.discover({
      fs: context.fs ?? {
        exists: () => false,
        readFile: () => undefined,
        readDir: () => [],
      },
      agentDir: context.agentDir ?? "",
      cwd: context.cwd,
      projectTrusted: context.projectTrusted,
    }).catalog;
  }
  private public(task: ForegroundTask): PublicForegroundTask {
    const snapshot = buildPublicTaskSnapshot(task);
    return task.status === "running" && task.mode === "task"
      ? {
          ...snapshot,
          backgroundable: true,
          backgroundShortcut:
            this.dependencies.config.backgroundHandoffShortcut ?? "ctrl+h",
        }
      : snapshot;
  }
  private sessionTasks(sessionId: string): PublicForegroundTask[] {
    return [...this.tasks.values()]
      .filter((task) => task.parentSessionId === sessionId)
      .map((task) => this.public(task));
  }
  private stored(id: string, sessionId: string) {
    const task = this.tasks.get(id);
    return task?.parentSessionId === sessionId
      ? task
      : this.dependencies.history?.get(id, sessionId);
  }
  list(sessionId?: string): PublicForegroundTask[] {
    const memory = [...this.tasks.values()]
      .filter((task) => !sessionId || task.parentSessionId === sessionId)
      .map((task) => this.public(task));
    const stored = (
      sessionId ? (this.dependencies.history?.list(sessionId) ?? []) : []
    ).map((task) => this.public(task));
    return [
      ...new Map(
        [...stored, ...memory].map((task) => [task.id, task]),
      ).values(),
    ];
  }
  /** Lightweight active-task projection for the terminal widget; never reads persisted history. */
  backgroundTasks(sessionId: string): BackgroundWidgetTask[] {
    return this.sessionTaskCache.get(sessionId) ?? [];
  }
  status(id: string, sessionId: string) {
    const task = this.stored(id, sessionId);
    return task ? this.public(task) : undefined;
  }
  result(id: string, sessionId: string) {
    const task = this.status(id, sessionId);
    if (!task) throw new Error(`Unknown task ${id}`);
    if (!terminal(task.status)) throw new Error(`Task ${id} is not complete`);
    return task;
  }
  /** Internal UI-only hydration. Exact parent-session ownership is mandatory. */
  thread(id: string, sessionId: string) {
    const task = this.stored(id, sessionId);
    return task ? sanitizeThreadSnapshot(task.thread) : undefined;
  }
  cancel(id: string, sessionId: string) {
    const task = this.tasks.get(id);
    if (!task || task.parentSessionId !== sessionId || terminal(task.status))
      return false;
    task.controller.abort("cancelled");
    return true;
  }
  cancelSession(sessionId: string) {
    return [...this.tasks.values()]
      .filter(
        (task) =>
          task.parentSessionId === sessionId && this.cancel(task.id, sessionId),
      )
      .map((task) => task.id);
  }
  /** A second Escape within the current interaction window cancels only this parent's tasks. */
  cancelOnDoubleEscape(sessionId: string) {
    const pressedAt = Date.now();
    const previous = this.escapePresses.get(sessionId);
    this.escapePresses.set(sessionId, pressedAt);
    if (!previous || pressedAt - previous > 750) return false;
    this.escapePresses.delete(sessionId);
    return this.cancelSession(sessionId).length > 0;
  }
  /** Detach the waiting foreground invocation; nested work remains live and becomes background work. */
  handoff(sessionId: string) {
    const active = [...this.tasks.values()].filter(
      (task) =>
        task.parentSessionId === sessionId &&
        !terminal(task.status) &&
        task.mode === "task",
    );
    if (!active.length) return false;
    for (const task of active) {
      task.mode = "background";
      this.recordNow(task);
    }
    this.changed();
    for (const release of this.handoffs.get(sessionId) ?? []) release();
    return true;
  }
  async shutdown(sessionId: string) {
    this.cancelSession(sessionId);
    await Promise.allSettled([...(this.operations.get(sessionId) ?? [])]);
    this.flushSessionRecords(sessionId);
  }
  dispose(sessionId: string) {
    return this.shutdown(sessionId);
  }
  private async drain(task: RuntimeTask): Promise<boolean> {
    if (!task.bridge || !task.messages.length) return !task.messages.length;
    while (task.bridge && task.messages.length) {
      const message = task.messages[0];
      try {
        await task.bridge.steer(message);
        task.messages.shift();
      } catch {
        return false;
      }
    }
    return !task.messages.length;
  }
  async sendMessage(id: string, sessionId: string, message: string) {
    if (!message.trim()) throw new Error("Message must not be empty");
    if (message.length > 8_000)
      throw new Error("Message exceeds 8000 characters");
    const task = this.tasks.get(id);
    if (!task || task.parentSessionId !== sessionId)
      throw new Error(`Unknown task ${id}`);
    if (terminal(task.status)) throw new Error(`Task ${id} is terminal`);
    if (task.messages.length >= 32)
      throw new Error("Live message queue is full");
    task.messages.push(message);
    const previous = task.draining ?? Promise.resolve(true);
    task.draining = previous.then(() => this.drain(task));
    const delivered = await task.draining;
    return {
      accepted: true,
      state: delivered ? ("delivered" as const) : ("queued" as const),
    };
  }
  private validateContinuation(path: string) {
    if (this.dependencies.continuationValidator)
      return this.dependencies.continuationValidator(path);
    try {
      const root = realpathSync(
        resolve((this.dependencies.continuationRoot ?? nestedSessionsRoot)()),
      );
      const candidate = realpathSync(resolve(path));
      if (!candidate.startsWith(`${root}${sep}`))
        throw new Error(
          "Continuation session path is outside the package-owned sessions root",
        );
      if (!statSync(candidate).isFile()) throw new Error("not a file");
      accessSync(candidate, constants.R_OK);
    } catch (error) {
      if (
        error instanceof Error &&
        /outside the package-owned/.test(error.message)
      )
        throw error;
      throw new Error(
        "Continuation session path is missing, unreadable, or invalid",
      );
    }
  }
  async continue(
    id: string,
    sessionId: string,
    prompt: string,
    context: Context,
    invocationSignal?: AbortSignal,
    requestedMode?: "task" | "background",
    onProgress?: (tasks: PublicForegroundTask[]) => void,
  ): Promise<
    | PublicForegroundTask
    | { mode: "background"; taskIds: string[]; results: PublicForegroundTask[] }
  > {
    if (this.dependencies.config.enableContinue === false)
      throw new Error("Subagent continuation is disabled by configuration");
    if (typeof prompt !== "string" || !prompt.trim())
      throw new Error("Continuation prompt must not be empty");
    if (prompt.length > 64_000)
      throw new Error("Continuation prompt exceeds 64000 characters");
    const previous = this.stored(id, sessionId);
    if (!previous) throw new Error(`Unknown task ${id}`);
    if (!terminal(previous.status))
      throw new Error(`Task ${id} is not terminal`);
    if (!previous.nestedSessionPath)
      throw new Error(
        `Task ${id} cannot be continued because its package-owned session data is unavailable`,
      );
    if (this.tasks.get(id)?.continuing)
      throw new Error(`Task ${id} continuation is already running`);
    const discovered = this.dependencies.catalog.discover({
      fs: context.fs ?? {
        exists: () => false,
        readFile: () => undefined,
        readDir: () => [],
      },
      agentDir: context.agentDir ?? "",
      cwd: context.cwd,
      projectTrusted: context.projectTrusted,
    });
    const definition = discovered.definitions[normalize(previous.agent)];
    if (!definition)
      throw new Error(
        `Task ${id} cannot be continued because agent "${previous.agent}" is no longer available in the current trusted catalog`,
      );
    this.validateContinuation(previous.nestedSessionPath);
    const mode =
      requestedMode ??
      previous.mode ??
      this.dependencies.config.defaultMode ??
      "task";
    const task: RuntimeTask = {
      ...previous,
      definition,
      mode,
      status: "queued",
      result: undefined,
      error: undefined,
      startedAt: undefined,
      finishedAt: undefined,
      attempt: (previous.attempt ?? 1) + 1,
      controller: new AbortController(),
      messages: [],
      continuing: true,
    };
    const abort = () =>
      task.controller.abort(invocationSignal?.reason ?? "cancelled");
    if (invocationSignal?.aborted) abort();
    else invocationSignal?.addEventListener("abort", abort, { once: true });
    this.tasks.set(id, task);
    this.recordNow(task);
    const run = this.track(
      task,
      this.execute(
        task,
        definition,
        previous.context,
        context,
        this.dependencies.config,
        mode === "task" ? onProgress : undefined,
        previous.nestedSessionPath,
        prompt,
      ),
    );
    const operation = this.trackOperation(sessionId, run);
    if (mode === "background") {
      void operation
        .catch(() => undefined)
        .finally(() => invocationSignal?.removeEventListener("abort", abort));
      return { mode, taskIds: [id], results: [] };
    }
    try {
      await operation;
      return this.result(id, sessionId);
    } finally {
      invocationSignal?.removeEventListener("abort", abort);
    }
  }
  async run(
    input: Input,
    context: Context,
    onProgress?: (tasks: PublicForegroundTask[]) => void,
    invocationSignal?: AbortSignal,
  ): Promise<{
    mode: "task" | "background" | "mixed";
    taskIds: string[];
    results: PublicForegroundTask[];
  }> {
    const names = this.validate(input);
    const config = this.dependencies.config;
    const discovered = this.dependencies.catalog.discover({
      fs: context.fs ?? {
        exists: () => false,
        readFile: () => undefined,
        readDir: () => [],
      },
      agentDir: context.agentDir ?? "",
      cwd: context.cwd,
      projectTrusted: context.projectTrusted,
    });
    const definitions = names.map((name) => {
      const definition = discovered.definitions[name];
      if (!definition)
        throw new Error(
          `Unknown agent "${name}"${discovered.diagnostics.length ? ` (${discovered.diagnostics.map((item) => item.message).join("; ")})` : ""}`,
        );
      return definition;
    });
    const modes = definitions.map(
      (definition) =>
        input.mode ?? definition.subagent_mode ?? config.defaultMode ?? "task",
    );
    const mode = new Set(modes).size === 1 ? modes[0] : "mixed";
    const tasks = definitions.map((definition, index) =>
      this.create(
        definition,
        input.task!.trim(),
        input.context,
        context.sessionId,
        modes[index],
      ),
    );
    this.changed();
    const abort = () =>
      tasks.forEach((task) => {
        task.controller.abort(invocationSignal?.reason ?? "cancelled");
      });
    if (invocationSignal?.aborted) abort();
    else invocationSignal?.addEventListener("abort", abort, { once: true });
    const completions = tasks.map(() => {
      let resolve!: () => void;
      return {
        promise: new Promise<void>((done) => {
          resolve = done;
        }),
        resolve,
      };
    });
    const work = async () => {
      let cursor = 0;
      const limit = Math.max(1, config.maxConcurrency ?? 1);
      await Promise.all(
        Array.from({ length: Math.min(limit, tasks.length) }, async () => {
          while (cursor < tasks.length) {
            const index = cursor++;
            try {
              await this.track(
                tasks[index],
                this.execute(
                  tasks[index],
                  definitions[index],
                  input.context,
                  context,
                  config,
                  tasks[index].mode === "task" ? onProgress : undefined,
                ),
              );
            } finally {
              completions[index].resolve();
            }
          }
          return undefined;
        }),
      );
    };
    const operation = this.trackOperation(context.sessionId, work());
    const foreground = tasks.filter((task) => task.mode === "task");
    if (!foreground.length) {
      void operation
        .catch(() => undefined)
        .finally(() => invocationSignal?.removeEventListener("abort", abort));
      return {
        mode: "background",
        taskIds: tasks.map((task) => task.id),
        results: [],
      };
    }
    let releaseHandoff!: () => void;
    const handedOff = new Promise<void>((resolve) => {
      releaseHandoff = resolve;
    });
    const handoffs =
      this.handoffs.get(context.sessionId) ?? new Set<() => void>();
    handoffs.add(releaseHandoff);
    this.handoffs.set(context.sessionId, handoffs);
    try {
      const foregroundOperation = Promise.all(
        tasks
          .filter((task) => task.mode === "task")
          .map((task) => completions[tasks.indexOf(task)].promise),
      );
      const outcome = await Promise.race([
        foregroundOperation.then(() => "complete" as const),
        handedOff.then(() => "handoff" as const),
      ]);
      if (outcome === "handoff")
        return {
          mode: "background",
          taskIds: tasks.map((task) => task.id),
          results: [],
        };
    } finally {
      const waiting = this.handoffs.get(context.sessionId);
      waiting?.delete(releaseHandoff);
      if (!waiting?.size) this.handoffs.delete(context.sessionId);
      invocationSignal?.removeEventListener("abort", abort);
    }
    return {
      mode,
      taskIds: tasks.map((task) => task.id),
      results: foreground.map((task) =>
        this.result(task.id, context.sessionId),
      ),
    };
  }
  private track(task: RuntimeTask, run: Promise<void>) {
    this.runs.set(task.id, run);
    return run.finally(() => {
      if (this.runs.get(task.id) === run) this.runs.delete(task.id);
    });
  }
  private trackOperation(sessionId: string, operation: Promise<unknown>) {
    const operations =
      this.operations.get(sessionId) ?? new Set<Promise<unknown>>();
    this.operations.set(sessionId, operations);
    const tracked = operation.finally(() => {
      operations.delete(tracked);
      if (!operations.size) this.operations.delete(sessionId);
    });
    operations.add(tracked);
    return tracked;
  }
  private create(
    definition: RuntimeAgentDefinition,
    task: string,
    context: string | undefined,
    parentSessionId: string,
    mode: "task" | "background",
  ): RuntimeTask {
    const created: RuntimeTask = {
      id: `subtask_${definition.name}_${randomUUID()}`,
      agent: definition.name,
      task,
      context,
      parentSessionId,
      mode,
      status: "queued",
      createdAt: now(),
      attempt: 1,
      definition,
      controller: new AbortController(),
      messages: [],
    };
    this.tasks.set(created.id, created);
    this.recordNow(created);
    return created;
  }
  private snapshot(task: RuntimeTask): ForegroundTask {
    const {
      controller: _c,
      bridge: _b,
      messages: _m,
      draining: _d,
      continuing: _n,
      definition: _definition,
      ...persisted
    } = task;
    return persisted;
  }
  private save(task: ForegroundTask) {
    try {
      this.dependencies.history?.save(task);
    } catch {
      /* history is best-effort; live task state remains authoritative */
    }
  }
  private record(task: RuntimeTask) {
    this.cacheBackgroundTask(task);
    this.pendingRecords.set(task.id, this.snapshot(task));
    if (!this.recordTimers.has(task.id))
      this.recordTimers.set(
        task.id,
        setTimeout(() => this.flushRecord(task.id), 250),
      );
  }
  private flushRecord(id: string) {
    const timer = this.recordTimers.get(id);
    if (timer) clearTimeout(timer);
    this.recordTimers.delete(id);
    const task = this.pendingRecords.get(id);
    this.pendingRecords.delete(id);
    if (task) this.save(task);
  }
  private recordNow(task: RuntimeTask) {
    this.cacheBackgroundTask(task);
    const timer = this.recordTimers.get(task.id);
    if (timer) clearTimeout(timer);
    this.recordTimers.delete(task.id);
    this.pendingRecords.delete(task.id);
    this.save(this.snapshot(task));
  }
  private flushSessionRecords(sessionId: string) {
    for (const [id, task] of this.pendingRecords)
      if (task.parentSessionId === sessionId) this.flushRecord(id);
  }
  private cacheBackgroundTask(task: RuntimeTask) {
    const sessionId = task.parentSessionId;
    if (!sessionId) return;
    const cached = this.sessionTaskCache.get(sessionId) ?? [];
    const active =
      task.mode === "background" &&
      (task.status === "queued" || task.status === "running");
    const remaining = cached.filter((item) => item.id !== task.id);
    if (active)
      remaining.push({
        id: task.id,
        agent: task.agent,
        mode: task.mode,
        status: task.status,
        liveActivity: task.liveActivity
          ? {
              current: task.liveActivity.current,
              trail: task.liveActivity.trail.slice(-1),
            }
          : undefined,
      });
    if (remaining.length) this.sessionTaskCache.set(sessionId, remaining);
    else this.sessionTaskCache.delete(sessionId);
  }
  private async execute(
    task: RuntimeTask,
    definition: RuntimeAgentDefinition,
    contextText: string | undefined,
    context: Context,
    config: CompatibleSubagentsConfig,
    update?: (tasks: PublicForegroundTask[]) => void,
    reopenPath?: string,
    continuationPrompt?: string,
  ) {
    if (task.controller.signal.aborted) {
      task.status = "cancelled";
      task.error = String(task.controller.signal.reason ?? "cancelled");
      task.finishedAt = now();
      this.recordNow(task);
      this.changed();
      if (task.mode === "background") {
        const snapshot = this.public(task);
        void Promise.resolve(
          this.completionNotifier
            ? this.completionNotifier(snapshot)
            : this.notifier?.(
                `Subagent ${task.id} (${task.agent}) cancelled: ${(task.error ?? "").slice(0, 500)}`,
              ),
        ).catch(() => undefined);
      }
      return;
    }
    task.status = "running";
    task.startedAt = now();
    this.recordNow(task);
    this.changed();
    update?.(this.sessionTasks(context.sessionId));
    const timeout = config.timeoutMs;
    let timedOut = false;
    const timer = timeout
      ? setTimeout(() => {
          timedOut = true;
          task.controller.abort("timeout");
        }, timeout)
      : undefined;
    let ticker: ReturnType<typeof setInterval> | undefined;
    try {
      const route = resolveEffectiveRoute({
        agent: definition.name,
        sessionId: context.sessionId,
        definition,
        config,
        routePort: this.dependencies.routePort,
        orchestrator: context.orchestrator,
      });
      task.model = route.model.value;
      task.effort = route.effort.value;
      const progress = () => update?.(this.sessionTasks(context.sessionId));
      if (update) ticker = setInterval(progress, 500);
      const response = await this.dependencies.runner.run({
        definition,
        task: this.public(task),
        context: contextText,
        cwd: context.cwd,
        sessionId: context.sessionId,
        signal: task.controller.signal,
        model: task.model,
        effort: task.effort,
        tools: definition.tools.length
          ? definition.tools
          : (config.defaultTools ?? []),
        config,
        ctx: context.ctx,
        reopenPath,
        continuationPrompt,
        onLiveBridge: (bridge) => {
          task.bridge = bridge;
          task.draining = (task.draining ?? Promise.resolve(true)).then(() =>
            this.drain(task),
          );
          void task.draining.catch(() => undefined);
        },
        onEvent: (event) => {
          task.liveActivity = processSubagentEvent(
            task.liveActivity ?? { trail: [] },
            event,
          );
          task.thread = appendThreadEvent(task.thread, event);
          if (task.liveActivity.usage) task.usage = task.liveActivity.usage;
          this.record(task);
          this.changed();
          progress();
        },
      });
      if (ticker) clearInterval(ticker);
      if (task.controller.signal.aborted)
        throw new Error(String(task.controller.signal.reason ?? "cancelled"));
      task.status = "completed";
      task.result = response.result;
      task.thread = appendThreadEvent(task.thread, {
        role: "assistant",
        content: response.result,
      });
      task.usage = response.usage;
      task.nestedSessionPath =
        response.nestedSessionPath ?? task.nestedSessionPath;
    } catch (error) {
      task.status = timedOut
        ? "failed"
        : task.controller.signal.aborted
          ? "cancelled"
          : "failed";
      task.error = timedOut
        ? `Task timeout after ${timeout}ms`
        : error instanceof Error
          ? error.message
          : String(error);
    } finally {
      if (timer) clearTimeout(timer);
      if (ticker) clearInterval(ticker);
      task.finishedAt = now();
      task.attempts = [
        ...(task.attempts ?? []),
        {
          attempt: task.attempt ?? 1,
          status: task.status,
          startedAt: task.startedAt,
          finishedAt: task.finishedAt,
          result: task.result,
          error: task.error,
          mode: task.mode,
        },
      ].slice(-20);
      task.bridge = undefined;
      task.continuing = false;
      this.recordNow(task);
      update?.(this.sessionTasks(context.sessionId));
      this.changed();
      if (task.mode === "background") {
        const snapshot = this.public(task);
        void Promise.resolve(
          this.completionNotifier
            ? this.completionNotifier(snapshot)
            : this.notifier?.(
                `Subagent ${task.id} (${task.agent}) ${task.status}: ${(task.result ?? task.error ?? "").slice(0, 500)}`,
              ),
        ).catch(() => undefined);
      }
    }
  }
}
