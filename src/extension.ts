import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands.js";
import { emptyConfig, mergeConfigs, validateConfig } from "./config.js";
import {
  DEFAULT_SHORTCUT,
  MODEL_ROUTE_EVENT,
  STATUS_KEY,
} from "./constants.js";
import { ProfileManager } from "./profile-manager.js";
import {
  internalAgentCatalog,
  readCompatibleSubagentsConfig,
} from "./subagents-runtime/discovery.js";
import type { CompatibleSubagentsConfig } from "./subagents-runtime/types.js";
import { ForegroundTaskManager } from "./subagents-runtime/manager.js";
import { createSdkForegroundRunner } from "./subagents-runtime/sdk-runner.js";
import { RuntimeHistory } from "./subagents-runtime/history.js";
import { createForegroundTools } from "./subagents-runtime/tools.js";
import {
  claimRuntimeOwner,
  releaseRuntimeOwner,
} from "./subagents-runtime/ownership.js";
import { selectToolNamespace } from "./subagents-runtime/tool-namespace.js";
import { openHistoryOverlay } from "./subagents-runtime/ui/panel-overlay.js";
import {
  BackgroundWidget,
  BackgroundWidgetState,
} from "./subagents-runtime/ui/background-widget.js";
import {
  completionMessage,
  completionMessageDetails,
  renderSubagentCompletionMessage,
} from "./subagents-runtime/render/completion-message.js";
import { createStorage, type Storage } from "./storage.js";
import type {
  Config,
  ExtensionContext,
  PiLike,
  Profile,
  RouteRequest,
} from "./types.js";

/** Reads only global config during construction so Pi can register its shortcut synchronously. */
function readGlobalConfigSync(path: string): Config {
  try {
    return (
      validateConfig(JSON.parse(readFileSync(path, "utf8"))).config ??
      emptyConfig()
    );
  } catch {
    return emptyConfig();
  }
}

const supportedShortcut = (key: string) =>
  /^(?:(?:ctrl|alt|shift|meta)\+)+(?:[a-z0-9]|tab|f(?:[1-9]|1[0-2]))$/i.test(
    key,
  );
/** Terminal input exposes Ctrl+letter as its single control byte; other registered chords stay Pi-owned. */
const terminalInputMatchesShortcut = (text: string, shortcut: string) => {
  const match = /^ctrl\+([a-z])$/i.exec(shortcut);
  return Boolean(
    match &&
      text.length === 1 &&
      text.charCodeAt(0) === match[1].toLowerCase().charCodeAt(0) - 96,
  );
};

export type ExtensionDependencies = {
  storage?: Storage;
  runtimeManagerFactory?: (
    config: CompatibleSubagentsConfig,
  ) => ForegroundTaskManager;
  runtimeHistoryFactory?: (config: CompatibleSubagentsConfig) => RuntimeHistory;
};

export default function extension(
  pi: PiLike,
  dependencies: ExtensionDependencies = {},
) {
  const storage = dependencies.storage ?? createStorage();
  const manager = new ProfileManager(pi);
  // ExtensionAPI cannot enumerate tools; retain the neutral synchronous probe for compatible runtimes.
  let preloadedCatalog = false;
  try {
    pi.events?.emit?.("pi-subagents:agents:v1", {
      version: 1,
      cwd: process.cwd(),
      setAgents(value: unknown) {
        if (Array.isArray(value)) preloadedCatalog = true;
      },
    });
  } catch {
    /* a foreign responder must not prevent loading */
  }
  let ownership = claimRuntimeOwner({ id: "pi-agent-profiles" });
  const toolNamespace = selectToolNamespace({
    agentDir: getAgentDir(),
    compatibleRuntimeDetected: preloadedCatalog,
    configDirName: CONFIG_DIR_NAME,
    cwd: process.cwd(),
    ownerClaimed: ownership.claimed,
    pathExists: existsSync,
  });
  const namespaceDiagnostic =
    toolNamespace === "agent_profiles_subagent_"
      ? "Subagent tools were registered with the agent_profiles_subagent_ namespace because another compatible runtime is active."
      : undefined;
  let reportedNamespaceDiagnostic = false;
  const runtimeManagers = new Map<string, ForegroundTaskManager>();
  const effectiveHandoffShortcuts = new Map<string, string>();
  const runtimeShutdowns = new Set<Promise<unknown>>();
  const backgroundWidgets = new Map<string, BackgroundWidgetState>();
  const historyPanels = new Set<string>();
  /** Pi owns terminal input dispatch; subscriptions are session-scoped and must not survive restart. */
  const terminalInputDisposers = new Map<string, () => void>();
  const widgetKey = (sessionId: string) =>
    `pi-agent-profiles:background:${sessionId}`;
  const runtimeFs = {
    exists(path: string) {
      try {
        return existsSync(path);
      } catch {
        return false;
      }
    },
    readFile(path: string) {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },
    readDir(path: string) {
      try {
        return readdirSync(path);
      } catch {
        return [];
      }
    },
  };
  const globalPath = join(getAgentDir(), "pi-agent-profiles", "config.json");
  const initialRuntimeConfig = readCompatibleSubagentsConfig({
    fs: runtimeFs,
    agentDir: getAgentDir(),
    cwd: process.cwd(),
    projectTrusted: false,
  });
  const backgroundHandoffShortcut =
    initialRuntimeConfig.backgroundHandoffShortcut ?? "ctrl+h";
  // Pi shortcut registration is construction-time: history remains a single global alt+o chord.
  const historyPanelShortcut =
    initialRuntimeConfig.historyPanelShortcut ?? "alt+o";
  const runtimeManagerFor = (ctx: ExtensionContext) =>
    runtimeManagers.get(ctx.sessionManager.getSessionId());
  const handoffFor = (ctx: ExtensionContext, shortcut: string) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (effectiveHandoffShortcuts.get(sessionId) !== shortcut) return false;
    const handedOff = runtimeManagerFor(ctx)?.handoff(sessionId) ?? false;
    if (handedOff)
      ctx.ui.notify(
        `Subagent work continues in the background (${shortcut}).`,
        "info",
      );
    return handedOff;
  };
  const createRuntimeManager =
    dependencies.runtimeManagerFactory ??
    ((config: CompatibleSubagentsConfig) =>
      new ForegroundTaskManager({
        runner: createSdkForegroundRunner(),
        catalog: internalAgentCatalog,
        routePort: manager,
        config,
      }));
  pi.registerMessageRenderer?.(
    "pi-agent-profiles:subagent-complete",
    renderSubagentCompletionMessage as never,
  );
  const refreshWidget = (ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const runtime = runtimeManagers.get(sessionId);
    let state = backgroundWidgets.get(sessionId);
    if (!state && runtime) {
      state = new BackgroundWidgetState(
        () => (runtimeManagers.get(sessionId) as any)?.backgroundTasks?.(sessionId) ?? [],
        () => refreshWidget(ctx),
      );
      backgroundWidgets.set(sessionId, state);
    }
    (ctx.ui as any).setWidget?.(
      widgetKey(sessionId),
      state
        ? (_tui: any, theme: any) => new BackgroundWidget(state!, theme)
        : undefined,
      { placement: "belowEditor" },
    );
  };
  let runtimeHistory: RuntimeHistory | undefined;
  const runtimeContextFor = (ctx: ExtensionContext) => ({
    cwd: ctx.cwd,
    projectTrusted: ctx.isProjectTrusted(),
    sessionId: ctx.sessionManager.getSessionId(),
    orchestrator: {
      model: ctx.model
        ? { provider: ctx.model.provider, id: ctx.model.id }
        : undefined,
      effort: pi.getThinkingLevel(),
    },
    ctx,
    agentDir: getAgentDir(),
    fs: runtimeFs,
  });
  for (const tool of createForegroundTools(
    runtimeManagerFor,
    runtimeContextFor,
    toolNamespace,
  ))
    pi.registerTool?.(tool as never);
  let globalConfig: Config = readGlobalConfigSync(globalPath);
  let projectConfig: Config = emptyConfig();
  let shortcutDiagnostic: string | undefined;
  const reportedDiscoveryDiagnostics = new Set<string>();
  const projectPath = (ctx: ExtensionContext) =>
    join(ctx.cwd, CONFIG_DIR_NAME, "pi-agent-profiles", "config.json");
  const report = (ctx: ExtensionContext, scope: string, invalid?: string) => {
    if (invalid) {
      ctx.ui.notify(
        `pi-agent-profiles ${scope} config is invalid: ${invalid}`,
        "error",
      );
    }
  };

  async function load(ctx: ExtensionContext) {
    manager.setContext(ctx);
    const global = await storage.read(globalPath);
    report(ctx, "global", global.invalid);
    globalConfig = global.invalid ? emptyConfig() : global.config;

    let project: { config: Config; invalid?: string } | undefined;
    if (ctx.isProjectTrusted()) {
      project = await storage.read(projectPath(ctx));
      report(ctx, "project", project.invalid);
      projectConfig = project.invalid ? emptyConfig() : project.config;
    } else {
      projectConfig = emptyConfig();
    }

    manager.setConfig(
      mergeConfigs(globalConfig, project?.invalid ? undefined : projectConfig),
    );
    const runtimeConfig = readCompatibleSubagentsConfig({
      fs: runtimeFs,
      agentDir: getAgentDir(),
      cwd: ctx.cwd,
      projectTrusted: ctx.isProjectTrusted(),
    });
    const sessionId = ctx.sessionManager.getSessionId();
    effectiveHandoffShortcuts.set(
      sessionId,
      runtimeConfig.backgroundHandoffShortcut ?? "ctrl+h",
    );
    const existingRuntimeManager = runtimeManagers.get(sessionId);
    if (!runtimeHistory && dependencies.runtimeHistoryFactory)
      try {
        runtimeHistory = dependencies.runtimeHistoryFactory(runtimeConfig);
      } catch {
        /* runtime remains usable when storage is unavailable */
      }
    if (existingRuntimeManager)
      existingRuntimeManager.updateConfig(runtimeConfig);
    else if (dependencies.runtimeManagerFactory)
      runtimeManagers.set(sessionId, createRuntimeManager(runtimeConfig));
    else {
      if (!runtimeHistory)
        try {
          runtimeHistory = new RuntimeHistory(
            join(
              getAgentDir(),
              "pi-agent-profiles",
              "runtime",
              "history.sqlite",
            ),
            runtimeConfig.historyLimit,
          );
        } catch {
          /* runtime remains usable when storage is unavailable */
        }
      runtimeManagers.set(
        sessionId,
        new ForegroundTaskManager({
          runner: createSdkForegroundRunner(),
          catalog: internalAgentCatalog,
          routePort: manager,
          config: runtimeConfig,
          history: runtimeHistory,
        }),
      );
    }
    const runtime = runtimeManagers.get(sessionId);
    runtime?.bindCompletionNotifier?.((task) =>
      pi.sendMessage?.(
        {
          customType: "pi-agent-profiles:subagent-complete",
          content: completionMessage(task),
          details: completionMessageDetails(task),
          display: true,
        },
        { triggerTurn: true, deliverAs: "followUp" },
      ),
    );
    runtime?.bindActivityListener?.(() => refreshWidget(ctx));
    refreshWidget(ctx);
    terminalInputDisposers.get(sessionId)?.();
    const onTerminalInput = (ctx.ui as any).onTerminalInput;
    if (typeof onTerminalInput === "function") {
      const dispose = onTerminalInput.call(ctx.ui, (data: string) => {
        if (historyPanels.has(sessionId)) return undefined;
        const widgetInput = backgroundWidgets
          .get(sessionId)
          ?.handleTerminalInput(data);
        if (widgetInput?.action?.type === "open-task")
          void showHistory(ctx, widgetInput.action.taskId);
        if (widgetInput?.consume) return { consume: true };
        if (data === "\u001b")
          runtimeManagerFor(ctx)?.cancelOnDoubleEscape(sessionId);
        const effectiveShortcut = effectiveHandoffShortcuts.get(sessionId);
        if (
          effectiveShortcut &&
          effectiveShortcut !== backgroundHandoffShortcut &&
          terminalInputMatchesShortcut(data, effectiveShortcut)
        ) {
          handoffFor(ctx, effectiveShortcut);
          return { consume: true };
        }
        return undefined;
      });
      if (typeof dispose === "function")
        terminalInputDisposers.set(sessionId, dispose);
    }
    const restored = manager.state.restore(ctx);
    if (shortcutDiagnostic) ctx.ui.notify(shortcutDiagnostic, "error");
    if (restored) {
      ctx.ui.setStatus(STATUS_KEY, restored.profile);
    } else if (
      manager.config.defaultProfile &&
      manager.state.shouldDefault(ctx.sessionManager.getSessionId())
    ) {
      await manager.use(manager.config.defaultProfile);
    }
  }

  async function save(
    ctx: ExtensionContext,
    name: string,
    profile: Profile | undefined,
    scope: "global" | "project",
    defaultProfile?: string,
  ) {
    if (scope === "project" && !ctx.isProjectTrusted()) {
      throw new Error(
        "Current project is not trusted; project profiles were not read or written",
      );
    }

    const path = scope === "global" ? globalPath : projectPath(ctx);
    await storage.mutate(path, (current) => {
      const profiles = { ...current.profiles };
      if (profile) profiles[name] = profile;
      else delete profiles[name];
      const { defaultProfile: currentDefault, ...config } = current;
      const nextDefault = profile
        ? defaultProfile ?? currentDefault
        : currentDefault === name
          ? undefined
          : currentDefault;
      return {
        ...config,
        profiles,
        ...(nextDefault ? { defaultProfile: nextDefault } : {}),
      };
    });
    await load(ctx);
  }

  const listener = (value: unknown) => {
    const request = value as RouteRequest;
    if (
      !request ||
      request.version !== 1 ||
      !request.sessionId ||
      typeof request.agent !== "string" ||
      typeof request.setRoute !== "function"
    ) {
      return;
    }

    const route = manager.resolveAgentRoute(request.agent, request.sessionId);
    if (route && (route.model || route.effort)) request.setRoute(route);
  };
  let runtimeReleased = false;
  let disposeEvent = pi.events?.on(MODEL_ROUTE_EVENT, listener);
  const reacquireRuntime = () => {
    if (!runtimeReleased) return;
    runtimeReleased = false;
    ownership = claimRuntimeOwner({ id: "pi-agent-profiles" });
    disposeEvent = pi.events?.on(MODEL_ROUTE_EVENT, listener);
  };

  pi.on("session_start", async (_event, ctx) => {
    try {
      reacquireRuntime();
      await load(ctx);
      if (namespaceDiagnostic && !reportedNamespaceDiagnostic) {
        ctx.ui.notify(namespaceDiagnostic, "warning");
        reportedNamespaceDiagnostic = true;
      }
      if (ownership.diagnostic) ctx.ui.notify(ownership.diagnostic, "warning");
    } catch (error: unknown) {
      ctx.ui.notify(
        error instanceof Error ? error.message : String(error),
        "error",
      );
    }
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const runtimeManager = runtimeManagers.get(sessionId);
    const settling = runtimeManager
      ? typeof (runtimeManager as any).shutdown === "function"
        ? (runtimeManager as any).shutdown(sessionId)
        : (runtimeManager as any).dispose?.(sessionId)
      : undefined;
    // Remove the manager immediately so no tool can target a closing parent session.
    runtimeManagers.delete(sessionId);
    effectiveHandoffShortcuts.delete(sessionId);
    backgroundWidgets.delete(sessionId);
    historyPanels.delete(sessionId);
    terminalInputDisposers.get(sessionId)?.();
    terminalInputDisposers.delete(sessionId);
    (ctx.ui as any).setWidget?.(widgetKey(sessionId), undefined);
    const cleanupFinal = () => {
      if (runtimeReleased) return;
      runtimeReleased = true;
      runtimeHistory?.close();
      runtimeHistory = undefined;
      disposeEvent?.();
      disposeEvent = undefined;
      releaseRuntimeOwner(ownership);
    };
    if (settling) {
      const shutdown = Promise.resolve(settling);
      runtimeShutdowns.add(shutdown);
      try {
        await shutdown;
      } finally {
        runtimeShutdowns.delete(shutdown);
      }
    }
    if (!runtimeManagers.size && !runtimeShutdowns.size) cleanupFinal();
    manager.state.clear(sessionId);
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
  const showHistory = async (ctx: ExtensionContext, initialTaskId?: string) => {
    try {
      await load(ctx);
      const sessionId = ctx.sessionManager.getSessionId();
      const runtime = runtimeManagerFor(ctx) as any;
      if (!runtime?.list || !runtime?.thread)
        return void ctx.ui.notify(
          "Subagent history is unavailable for this session.",
          "error",
        );
      historyPanels.add(sessionId);
      try {
        const runtimeConfig = readCompatibleSubagentsConfig({
          fs: runtimeFs,
          agentDir: getAgentDir(),
          cwd: ctx.cwd,
          projectTrusted: ctx.isProjectTrusted(),
        });
        await openHistoryOverlay(ctx, {
          tasks: () => runtime.list(sessionId),
          detail: (id) => runtime.thread(id, sessionId),
          cancel: (id) => runtime.cancel(id, sessionId),
          initialTaskId,
          detailCancelKey: runtimeConfig.detailCancelShortcut ?? "x",
          timeoutMs: runtimeConfig.timeoutMs,
          stallTimeoutMs: runtimeConfig.stallTimeoutMs,
          contextWindowForTask: (task) => {
            const model =
              task.model?.provider && task.model?.id
                ? ctx.modelRegistry?.find?.(task.model.provider, task.model.id)
                : ctx.model;
            const window = Number((model as any)?.contextWindow);
            return Number.isFinite(window) && window > 0 ? window : undefined;
          },
        });
      } finally {
        historyPanels.delete(sessionId);
        refreshWidget(ctx);
      }
    } catch (error) {
      ctx.ui.notify(
        error instanceof Error ? error.message : String(error),
        "error",
      );
    }
  };
  pi.registerCommand("subagents", {
    description: "Browse subagent task history for this session",
    handler(_args: string, ctx: ExtensionContext) {
      return showHistory(ctx);
    },
  });
  registerCommands(
    pi,
    manager,
    save,
    load,
    () =>
      Object.fromEntries(
        manager
          .names()
          .map((name) => [
            name,
            Object.hasOwn(projectConfig.profiles, name) ? "project" : "global",
          ]),
      ),
    (ctx) => {
      try {
        const result = internalAgentCatalog.discover({
          fs: runtimeFs,
          agentDir: getAgentDir(),
          cwd: ctx.cwd,
          projectTrusted: ctx.isProjectTrusted(),
        });
        for (const diagnostic of result.diagnostics) {
          const message = `Internal agent discovery: ${diagnostic.message}${diagnostic.path ? ` (${diagnostic.path})` : ""}`;
          if (!reportedDiscoveryDiagnostics.has(message)) {
            reportedDiscoveryDiagnostics.add(message);
            ctx.ui.notify(message, "warning");
          }
        }
        return result.catalog;
      } catch {
        const message =
          "Internal agent catalog is unavailable; using the optional catalog fallback";
        if (!reportedDiscoveryDiagnostics.has(message)) {
          reportedDiscoveryDiagnostics.add(message);
          ctx.ui.notify(message, "warning");
        }
        return undefined;
      }
    },
  );

  pi.registerShortcut(
    historyPanelShortcut as Parameters<PiLike["registerShortcut"]>[0],
    {
      description: "Browse subagent history",
      handler(ctx: ExtensionContext) {
        void showHistory(ctx);
      },
    },
  );
  pi.registerShortcut(
    backgroundHandoffShortcut as Parameters<PiLike["registerShortcut"]>[0],
    {
      description: "Send foreground subagent work to background",
      handler(ctx: ExtensionContext) {
        handoffFor(ctx, backgroundHandoffShortcut);
      },
    },
  );

  const shortcut = globalConfig.shortcut ?? DEFAULT_SHORTCUT;
  const shortcutOptions = {
    description: "Cycle agent profile",
    async handler(ctx: ExtensionContext) {
      manager.setContext(ctx);
      try {
        await manager.next();
      } catch (error: unknown) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
    },
  };

  if (!supportedShortcut(shortcut)) {
    shortcutDiagnostic = `pi-agent-profiles global shortcut is invalid; using ${DEFAULT_SHORTCUT}`;
  }
  try {
    pi.registerShortcut(
      (shortcutDiagnostic ? DEFAULT_SHORTCUT : shortcut) as Parameters<
        PiLike["registerShortcut"]
      >[0],
      shortcutOptions,
    );
  } catch {
    shortcutDiagnostic = `pi-agent-profiles global shortcut could not be registered; using ${DEFAULT_SHORTCUT}`;
    pi.registerShortcut(
      DEFAULT_SHORTCUT as Parameters<PiLike["registerShortcut"]>[0],
      shortcutOptions,
    );
  }
}
