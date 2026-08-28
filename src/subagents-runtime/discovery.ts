import { basename, join } from "node:path";
import type { CatalogAgent, Route } from "../types.js";
import type {
  AgentCatalogPort,
  AgentDirectoryKind,
  CompatibleSubagentsConfig,
  DiscoveryInput,
  DiscoveryResult,
  RuntimeAgentDefinition,
  RuntimeDiagnostic,
  RuntimeFileSystem,
  RuntimeScope,
} from "./types.js";

export type {
  AgentCatalogPort,
  CompatibleSubagentsConfig,
  DiscoveryInput,
  DiscoveryResult,
  RuntimeFileSystem,
} from "./types.js";

const DEFAULT_TOOLS = [
  "read",
  "memory_context",
  "memory_search",
  "memory_recall",
  "memory_get",
];
const EFFORTS = new Set<Route["effort"]>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const normalize = (value: string) => value.trim().toLowerCase();
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const sanitizeTools = (tools: unknown[]) =>
  tools
    .map(String)
    .filter(
      (tool) =>
        !tool.startsWith("subagent_") &&
        !tool.startsWith("agent_profiles_subagent_"),
    );

function model(value: unknown) {
  if (typeof value === "string") {
    const [provider, id, ...rest] = value.split("/").map((part) => part.trim());
    return provider && id && !rest.length ? { provider, id } : undefined;
  }
  if (
    object(value) &&
    typeof value.provider === "string" &&
    value.provider.trim() &&
    typeof value.id === "string" &&
    value.id.trim()
  ) {
    return { provider: value.provider.trim(), id: value.id.trim() };
  }
  return undefined;
}

type FrontmatterScalar = string | boolean | number;

function scalar(value: string): FrontmatterScalar {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed.replace(/^["']|["']$/g, "");
}

function frontmatter(text: string): {
  data: Record<string, unknown>;
  body: string;
  issue?: string;
} {
  const opening = text.match(/^---\r?\n/);
  if (!opening) return { data: {}, body: text };
  const remainder = text.slice(opening[0].length);
  const closing = /(?:^|\r?\n)---(?=\r?\n|$)/.exec(remainder);
  if (!closing) return { data: {}, body: text };
  const data: Record<string, unknown> = {};
  let key: string | undefined;
  let toolsFormat: "inline" | "multiline" | undefined;
  let toolsCount = 0;
  for (const raw of remainder.slice(0, closing.index).trim().split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const list = raw.match(/^\s*-\s+(.+)$/);
    if (list && key === "tools") {
      if (toolsFormat === "inline")
        return { data, body: text, issue: "tools frontmatter is ambiguous" };
      toolsFormat = "multiline";
      data.tools = [
        ...(Array.isArray(data.tools) ? data.tools : []),
        scalar(list[1]),
      ];
      continue;
    }
    const field = raw.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!field) continue;
    key = field[1];
    if (key === "tools") {
      const format = field[2].trim() ? "inline" : "multiline";
      if (toolsCount++ || (toolsFormat && toolsFormat !== format))
        return { data, body: text, issue: "tools frontmatter is ambiguous" };
      toolsFormat = format;
      data.tools =
        format === "inline"
          ? field[2].split(",").map(scalar).filter(Boolean)
          : [];
    } else data[key] = scalar(field[2]);
  }
  return {
    data,
    body: remainder
      .slice(closing.index + closing[0].length)
      .replace(/^\r?\n/, ""),
  };
}

function definitionsFromDirectory(
  input: DiscoveryInput,
  dir: string,
  scope: RuntimeScope,
  source: AgentDirectoryKind,
  diagnostics: RuntimeDiagnostic[],
) {
  if (!input.fs.exists(dir))
    return {
      definitions: [] as RuntimeAgentDefinition[],
      blocked: new Set<string>(),
    };
  const definitions: RuntimeAgentDefinition[] = [];
  const blocked = new Set<string>();
  for (const file of input.fs
    .readDir(dir)
    .filter((file) => file.endsWith(".md"))
    .sort()) {
    const filePath = join(dir, file);
    const text = input.fs.readFile(filePath);
    if (text === undefined) {
      diagnostics.push({
        path: filePath,
        message: "Agent definition was ignored: file is unreadable",
      });
      continue;
    }
    const parsed = frontmatter(text);
    const name = normalize(String(parsed.data.name ?? basename(file, ".md")));
    if (!name || parsed.issue) {
      if (name) blocked.add(name);
      diagnostics.push({
        path: filePath,
        message: `Agent definition was ignored: ${parsed.issue ?? "name is empty"}`,
      });
      continue;
    }
    const mode = parsed.data.subagent_mode;
    if (mode !== undefined && mode !== "task" && mode !== "background") {
      blocked.add(name);
      diagnostics.push({
        path: filePath,
        message:
          'Agent definition was ignored: subagent_mode must be exactly "task" or "background"',
      });
      continue;
    }
    const effortValue = normalize(
      String(
        parsed.data.effort ??
          parsed.data.thinking_level ??
          parsed.data.thinkingLevel ??
          "",
      ),
    );
    definitions.push({
      name,
      description:
        String(parsed.data.description ?? `${name} agent`).trim() ||
        `${name} agent`,
      scope,
      filePath,
      instructions: parsed.body.trim(),
      tools: sanitizeTools(
        Array.isArray(parsed.data.tools) ? parsed.data.tools : DEFAULT_TOOLS,
      ),
      ...(model(parsed.data.model) ? { model: model(parsed.data.model) } : {}),
      ...(EFFORTS.has(effortValue as Route["effort"])
        ? { effort: effortValue as Route["effort"] }
        : {}),
      ...(mode ? { subagent_mode: mode } : {}),
      source,
    });
  }
  return { definitions, blocked };
}

export function discoverAgents(input: DiscoveryInput): DiscoveryResult {
  const diagnostics: RuntimeDiagnostic[] = [];
  const selected = new Map<string, RuntimeAgentDefinition>();
  const sources: Array<{
    scope: RuntimeScope;
    source: AgentDirectoryKind;
    dir: string;
  }> = [
    { scope: "global", source: "agents", dir: join(input.agentDir, "agents") },
    {
      scope: "global",
      source: "subagents",
      dir: join(input.agentDir, "subagents"),
    },
    ...(input.projectTrusted
      ? [
          {
            scope: "project" as const,
            source: "agents" as const,
            dir: join(input.cwd, ".pi", "agents"),
          },
          {
            scope: "project" as const,
            source: "subagents" as const,
            dir: join(input.cwd, ".pi", "subagents"),
          },
        ]
      : []),
  ];
  for (const source of sources) {
    const loaded = definitionsFromDirectory(
      input,
      source.dir,
      source.scope,
      source.source,
      diagnostics,
    );
    for (const name of loaded.blocked) selected.delete(name);
    for (const definition of loaded.definitions) {
      const previous = selected.get(definition.name);
      if (previous)
        diagnostics.push({
          path: definition.filePath,
          message: `Duplicate agent name "${definition.name}"; using ${source.scope} ${source.source} definition over ${previous.scope} ${previous.source}`,
        });
      selected.set(definition.name, definition);
    }
  }
  const definitions = Object.fromEntries(
    [...selected.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
  const catalog: CatalogAgent[] = Object.values(definitions).map(
    ({ name, description, scope }) => ({ name, description, scope }),
  );
  return { catalog, definitions, diagnostics };
}

function parseJson(
  fs: RuntimeFileSystem,
  path: string,
  diagnostics: RuntimeDiagnostic[],
): Record<string, unknown> {
  if (!fs.exists(path)) return {};
  const text = fs.readFile(path);
  if (text === undefined) {
    diagnostics.push({ path, message: "subagents.json is unreadable" });
    return {};
  }
  try {
    const value = JSON.parse(text);
    if (object(value)) return value;
    diagnostics.push({
      path,
      message: "subagents.json must contain an object",
    });
  } catch {
    diagnostics.push({ path, message: "subagents.json contains invalid JSON" });
  }
  return {};
}
function profiles(
  value: unknown,
  path: string,
  diagnostics: RuntimeDiagnostic[],
): Record<string, Route> {
  if (value === undefined) return {};
  if (!object(value)) {
    diagnostics.push({
      path,
      message: "subagents.json model_profiles must be an object",
    });
    return {};
  }
  const result: Record<string, Route> = {};
  for (const [name, raw] of Object.entries(value)) {
    if (!object(raw)) {
      diagnostics.push({
        path,
        message: `subagents.json model profile "${name}" must be an object`,
      });
      continue;
    }
    const route: Route = {};
    if (raw.model !== undefined) {
      const parsed = model(raw.model);
      if (!parsed) {
        diagnostics.push({
          path,
          message: `subagents.json model profile "${name}" has an invalid model`,
        });
        continue;
      }
      route.model = parsed;
    }
    const effortValue = normalize(
      String(raw.effort ?? raw.thinking_level ?? raw.thinkingLevel ?? ""),
    );
    if (
      raw.effort !== undefined ||
      raw.thinking_level !== undefined ||
      raw.thinkingLevel !== undefined
    ) {
      if (!EFFORTS.has(effortValue as Route["effort"])) {
        diagnostics.push({
          path,
          message: `subagents.json model profile "${name}" has an invalid effort`,
        });
        continue;
      }
      route.effort = effortValue as Route["effort"];
    }
    if (Object.keys(route).length) result[normalize(name)] = route;
  }
  return result;
}
function defaultModel(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: RuntimeDiagnostic[],
) {
  if (raw.default_model === undefined) return undefined;
  const parsed = model(raw.default_model);
  if (!parsed)
    diagnostics.push({
      path,
      message: "subagents.json default_model is invalid",
    });
  return parsed;
}
function positiveInteger(
  raw: Record<string, unknown>,
  key: string,
  path: string,
  diagnostics: RuntimeDiagnostic[],
) {
  if (raw[key] === undefined) return undefined;
  if (!Number.isInteger(raw[key]) || Number(raw[key]) <= 0) {
    diagnostics.push({
      path,
      message: `subagents.json ${key} must be a positive integer`,
    });
    return undefined;
  }
  return Number(raw[key]);
}
function tools(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: RuntimeDiagnostic[],
) {
  if (raw.default_tools === undefined) return undefined;
  if (
    !Array.isArray(raw.default_tools) ||
    !raw.default_tools.every((item) => typeof item === "string" && item.trim())
  ) {
    diagnostics.push({
      path,
      message: "subagents.json default_tools must be a string array",
    });
    return undefined;
  }
  return sanitizeTools(raw.default_tools);
}
function choice(
  raw: Record<string, unknown>,
  key: string,
  values: readonly string[],
  path: string,
  diagnostics: RuntimeDiagnostic[],
) {
  if (raw[key] === undefined) return undefined;
  if (typeof raw[key] !== "string" || !values.includes(raw[key])) {
    diagnostics.push({ path, message: `subagents.json ${key} is invalid` });
    return undefined;
  }
  return raw[key];
}
function defaultEffort(
  raw: Record<string, unknown>,
  path: string,
  diagnostics: RuntimeDiagnostic[],
) {
  const value =
    raw.default_effort ?? raw.default_thinking_level ?? raw.thinkingLevel;
  if (value === undefined) return undefined;
  const parsed = normalize(String(value));
  if (!EFFORTS.has(parsed as Route["effort"])) {
    diagnostics.push({
      path,
      message: "subagents.json default effort is invalid",
    });
    return undefined;
  }
  return parsed as Route["effort"];
}

/** Read-only compatibility subset required by the foreground runtime. */
export function readCompatibleSubagentsConfig(
  input: DiscoveryInput,
): CompatibleSubagentsConfig {
  const diagnostics: RuntimeDiagnostic[] = [];
  const globalPath = join(input.agentDir, "subagents.json");
  const projectPath = join(input.cwd, ".pi", "subagents.json");
  const global = parseJson(input.fs, globalPath, diagnostics);
  const project = input.projectTrusted
    ? parseJson(input.fs, projectPath, diagnostics)
    : {};
  const globalModel = defaultModel(global, globalPath, diagnostics);
  const projectModel = input.projectTrusted
    ? defaultModel(project, projectPath, diagnostics)
    : undefined;
  const globalEffort = defaultEffort(global, globalPath, diagnostics);
  const projectEffort = input.projectTrusted
    ? defaultEffort(project, projectPath, diagnostics)
    : undefined;
  const pick = <T>(
    projectValue: T | undefined,
    globalValue: T | undefined,
    fallback: T,
  ) => projectValue ?? globalValue ?? fallback;
  const globalTimeout = positiveInteger(
    global,
    "timeout_ms",
    globalPath,
    diagnostics,
  );
  const projectTimeout = input.projectTrusted
    ? positiveInteger(project, "timeout_ms", projectPath, diagnostics)
    : undefined;
  const globalStall = positiveInteger(
    global,
    "stall_timeout_ms",
    globalPath,
    diagnostics,
  );
  const projectStall = input.projectTrusted
    ? positiveInteger(project, "stall_timeout_ms", projectPath, diagnostics)
    : undefined;
  const globalConcurrency = positiveInteger(
    global,
    "max_concurrency",
    globalPath,
    diagnostics,
  );
  const projectConcurrency = input.projectTrusted
    ? positiveInteger(project, "max_concurrency", projectPath, diagnostics)
    : undefined;
  const globalTools = tools(global, globalPath, diagnostics);
  const projectTools = input.projectTrusted
    ? tools(project, projectPath, diagnostics)
    : undefined;
  const globalResources = choice(
    global,
    "session_resources",
    ["lean", "full"],
    globalPath,
    diagnostics,
  ) as "lean" | "full" | undefined;
  const projectResources = input.projectTrusted
    ? (choice(
        project,
        "session_resources",
        ["lean", "full"],
        projectPath,
        diagnostics,
      ) as "lean" | "full" | undefined)
    : undefined;
  const globalMode = choice(
    global,
    "default_mode",
    ["task", "background"],
    globalPath,
    diagnostics,
  ) as "task" | "background" | undefined;
  const projectMode = input.projectTrusted
    ? (choice(
        project,
        "default_mode",
        ["task", "background"],
        projectPath,
        diagnostics,
      ) as "task" | "background" | undefined)
    : undefined;
  const globalHistoryLimit = positiveInteger(
    global,
    "history_limit",
    globalPath,
    diagnostics,
  );
  const projectHistoryLimit = input.projectTrusted
    ? positiveInteger(project, "history_limit", projectPath, diagnostics)
    : undefined;
  const handoffShortcut = (
    raw: Record<string, unknown>,
    path: string,
    projectOverride = false,
  ) => {
    const value = raw.background_handoff_shortcut;
    if (value === undefined) return undefined;
    if (
      typeof value !== "string" ||
      !/^(?:(?:ctrl|alt|shift|meta)\+)+(?:[a-z0-9]|f(?:[1-9]|1[0-2]))$/i.test(
        value,
      )
    ) {
      diagnostics.push({
        path,
        message: "subagents.json background_handoff_shortcut is invalid",
      });
      return undefined;
    }
    if (projectOverride && !/^ctrl\+[a-z]$/i.test(value)) {
      diagnostics.push({
        path,
        message:
          "trusted-project background_handoff_shortcut must be Ctrl+letter because Pi shortcut registration is construction-time",
      });
      return undefined;
    }
    return value.toLowerCase();
  };
  const globalHandoffShortcut = handoffShortcut(global, globalPath);
  const projectHandoffShortcut = input.projectTrusted
    ? handoffShortcut(project, projectPath, true)
    : undefined;
  const historyShortcut = (raw: Record<string, unknown>, path: string) => {
    const value = raw.history_panel_shortcut;
    if (value === undefined) return undefined;
    if (typeof value !== "string") {
      diagnostics.push({
        path,
        message:
          "subagents.json history_panel_shortcut is unsupported; only alt+o is globally effective",
      });
      return undefined;
    }
    const shortcut = value.toLowerCase();
    if (shortcut === "ctrl+,") return "alt+o";
    if (shortcut !== "alt+o") {
      diagnostics.push({
        path,
        message:
          "subagents.json history_panel_shortcut is unsupported; only alt+o is globally effective",
      });
      return undefined;
    }
    return "alt+o";
  };
  const cancelShortcut = (raw: Record<string, unknown>, path: string) => {
    const value = raw.detail_cancel_shortcut;
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !/^[a-z]$/i.test(value)) {
      diagnostics.push({
        path,
        message: "subagents.json detail_cancel_shortcut must be one letter",
      });
      return undefined;
    }
    return value.toLowerCase();
  };
  const globalHistoryShortcut = historyShortcut(global, globalPath);
  const globalCancelShortcut = cancelShortcut(global, globalPath);
  const projectCancelShortcut = input.projectTrusted
    ? cancelShortcut(project, projectPath)
    : undefined;
  const continueValue = (raw: Record<string, unknown>, path: string) =>
    raw.enable_continue === undefined
      ? undefined
      : typeof raw.enable_continue === "boolean"
        ? raw.enable_continue
        : (diagnostics.push({
            path,
            message: "subagents.json enable_continue must be a boolean",
          }),
          undefined);
  const globalContinue = continueValue(global, globalPath);
  const projectContinue = input.projectTrusted
    ? continueValue(project, projectPath)
    : undefined;
  return {
    ...((projectModel ?? globalModel)
      ? { defaultModel: projectModel ?? globalModel }
      : {}),
    ...((projectEffort ?? globalEffort)
      ? { defaultEffort: projectEffort ?? globalEffort }
      : {}),
    timeoutMs: pick(projectTimeout, globalTimeout, 1_200_000),
    stallTimeoutMs: pick(projectStall, globalStall, 240_000),
    maxConcurrency: pick(projectConcurrency, globalConcurrency, 5),
    defaultTools: pick(projectTools, globalTools, DEFAULT_TOOLS),
    sessionResources: pick(projectResources, globalResources, "lean"),
    defaultMode: pick(projectMode, globalMode, "task"),
    historyLimit: pick(projectHistoryLimit, globalHistoryLimit, 100),
    enableContinue: pick(projectContinue, globalContinue, true),
    backgroundHandoffShortcut: pick(
      projectHandoffShortcut,
      globalHandoffShortcut,
      "ctrl+h",
    ),
    historyPanelShortcut: globalHistoryShortcut ?? "alt+o",
    detailCancelShortcut: pick(
      projectCancelShortcut,
      globalCancelShortcut,
      "x",
    ),
    globalModelProfiles: profiles(
      global.model_profiles,
      globalPath,
      diagnostics,
    ),
    projectModelProfiles: input.projectTrusted
      ? profiles(project.model_profiles, projectPath, diagnostics)
      : {},
    diagnostics,
  };
}

export const internalAgentCatalog: AgentCatalogPort = {
  discover: discoverAgents,
};
