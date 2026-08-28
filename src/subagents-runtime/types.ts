import type { CatalogAgent, Route } from "../types.js";
import type { ThreadSnapshot } from "./thread-view.js";

export type RuntimeScope = "global" | "project";
export type AgentDirectoryKind = "agents" | "subagents";
export type RuntimeDiagnostic = { message: string; path?: string };
export type RuntimeFileSystem = {
  exists(path: string): boolean;
  readFile(path: string): string | undefined;
  readDir(path: string): string[];
};
export type RuntimeAgentDefinition = CatalogAgent & {
  filePath: string;
  instructions: string;
  tools: string[];
  model?: { provider: string; id: string };
  effort?: Route["effort"];
  subagent_mode?: "task" | "background";
  source: AgentDirectoryKind;
};
export type DiscoveryInput = {
  fs: RuntimeFileSystem;
  agentDir: string;
  cwd: string;
  projectTrusted: boolean;
};
export type DiscoveryResult = {
  catalog: CatalogAgent[];
  definitions: Record<string, RuntimeAgentDefinition>;
  diagnostics: RuntimeDiagnostic[];
};
export type SessionResources = "lean" | "full";
export type CompatibleSubagentsConfig = {
  defaultModel?: { provider: string; id: string };
  defaultEffort?: Route["effort"];
  timeoutMs?: number;
  stallTimeoutMs?: number;
  maxConcurrency?: number;
  defaultTools?: string[];
  sessionResources?: SessionResources;
  defaultMode?: "task" | "background";
  historyLimit?: number;
  enableContinue?: boolean;
  backgroundHandoffShortcut?: string;
  historyPanelShortcut?: string;
  detailCancelShortcut?: string;
  globalModelProfiles: Record<string, Route>;
  projectModelProfiles: Record<string, Route>;
  diagnostics: RuntimeDiagnostic[];
};
export type ResolvedField<T> = {
  value?: T;
  source:
    | "route"
    | "profile"
    | "definition"
    | "default"
    | "orchestrator"
    | "unresolved";
};
export type EffectiveRoute = {
  agent: string;
  model: ResolvedField<{ provider: string; id: string }>;
  effort: ResolvedField<Route["effort"]>;
};
export type ForegroundTaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";
export type LiveActivityEntry = {
  label: string;
  kind: "semantic" | "fallback";
};
export type LiveActivity = {
  trail: LiveActivityEntry[];
  current?: LiveActivityEntry;
  usage?: Record<string, number>;
};
export type TaskAttempt = {
  attempt: number;
  status: ForegroundTaskStatus;
  startedAt?: string;
  finishedAt?: string;
  result?: string;
  error?: string;
  mode?: "task" | "background";
};
/** Internal, persisted task state. Definition resolution remains in the trusted runtime catalog. */
export type ForegroundTask = {
  id: string;
  agent: string;
  task: string;
  status: ForegroundTaskStatus;
  createdAt: string;
  parentSessionId?: string;
  mode?: "task" | "background";
  context?: string;
  startedAt?: string;
  finishedAt?: string;
  result?: string;
  error?: string;
  usage?: unknown;
  model?: { provider: string; id: string };
  effort?: Route["effort"];
  nestedSessionPath?: string;
  attempt?: number;
  attempts?: TaskAttempt[];
  liveActivity?: LiveActivity /** Internal sanitized timeline; never part of public tool projections. */;
  thread?: ThreadSnapshot;
};
/** Deliberately bounded task projection for parent-facing tool details and progress. */
export type PublicForegroundTask = Pick<
  ForegroundTask,
  | "id"
  | "agent"
  | "task"
  | "status"
  | "createdAt"
  | "mode"
  | "startedAt"
  | "finishedAt"
  | "result"
  | "error"
  | "usage"
  | "model"
  | "effort"
  | "attempt"
  | "liveActivity"
> & { backgroundable?: boolean; backgroundShortcut?: string };
export type LiveBridge = { steer(message: string): Promise<void> | void };
export type ForegroundRunnerInput = {
  definition: RuntimeAgentDefinition;
  task: PublicForegroundTask;
  context?: string;
  cwd: string;
  sessionId: string;
  signal: AbortSignal;
  model?: { provider: string; id: string };
  effort?: Route["effort"];
  tools: string[];
  config: CompatibleSubagentsConfig;
  ctx: unknown;
  reopenPath?: string;
  continuationPrompt?: string;
  onLiveBridge?: (bridge: LiveBridge) => void;
  onEvent?: (event: unknown) => void;
};
export type ForegroundRunner = {
  run(
    input: ForegroundRunnerInput,
  ): Promise<{
    result: string;
    usage?: unknown;
    nestedSessionPath?: string;
    model?: { provider: string; id: string };
    effort?: Route["effort"];
  }>;
};

/** Internal future-runner catalog boundary; event transport is deliberately excluded. */
export interface AgentCatalogPort {
  discover(input: DiscoveryInput): DiscoveryResult;
}
/** Internal future-runner route boundary; values are resolved directly for an exact session. */
export interface AgentRoutePort {
  resolveAgentRoute(agent: string, sessionId: string): Route | undefined;
}
