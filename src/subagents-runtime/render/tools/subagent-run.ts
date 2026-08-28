// Independently adapted from pi-subagents-j0k3r (MIT); see THIRD_PARTY_NOTICES.md.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  internalAgentCatalog,
  readCompatibleSubagentsConfig,
} from "../../discovery.js";
import { textComponent, wrappedTextComponent } from "../components.js";
import {
  collapsedResultHint,
  failed,
  formatUsage,
  modelLabel,
  taskFromDetails,
} from "../formatting.js";
import { progressText } from "../progress.js";

const fg = (theme: any, kind: string, text: string) =>
  theme?.fg?.(kind, text) ?? text;
const runtimeFs = {
  exists: (path: string) => existsSync(path),
  readFile: (path: string) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
  readDir: (path: string) => {
    try {
      return readdirSync(path);
    } catch {
      return [];
    }
  },
};
/** Exact visible counterpart of run precedence: invocation → definition → compatible config. */
export function resolveRenderedSubagentRunMode(
  args: any,
  cwd = process.cwd(),
): "task" | "background" | "mixed" {
  if (args?.mode === "task" || args?.mode === "background") return args.mode;
  try {
    const input = {
      fs: runtimeFs,
      agentDir: getAgentDir(),
      cwd,
      projectTrusted: true,
    };
    const config = readCompatibleSubagentsConfig(input);
    const definitions = internalAgentCatalog.discover(input).definitions;
    const names =
      Array.isArray(args?.agents) && args.agents.length
        ? args.agents
        : args?.agent
          ? [args.agent]
          : [];
    const modes = new Set(
      names.map(
        (name: string) =>
          definitions[String(name).toLowerCase()]?.subagent_mode ??
          config.defaultMode ??
          "task",
      ),
    );
    return modes.size > 1
      ? "mixed"
      : ((modes.values().next().value ?? config.defaultMode ?? "task") as
          | "task"
          | "background");
  } catch {
    return "task";
  }
}
export function renderSubagentCall(
  args: any,
  theme: any,
  title = "subagent",
  detail?: string,
) {
  const agents =
    Array.isArray(args?.agents) && args.agents.length
      ? args.agents.join(", ")
      : (args?.agent ?? "subagent");
  let shortcut = "alt+o";
  try {
    shortcut =
      readCompatibleSubagentsConfig({
        fs: runtimeFs,
        agentDir: getAgentDir(),
        cwd: process.cwd(),
        projectTrusted: true,
      }).historyPanelShortcut ?? shortcut;
  } catch {
    /* safe rendering fallback */
  }
  const heading = fg(
    theme,
    "toolTitle",
    theme?.bold?.(`${title} `) ?? `${title} `,
  );
  const call = `${heading}${fg(theme, "accent", agents)}${fg(theme, "dim", ` (${resolveRenderedSubagentRunMode(args)}) (${shortcut} or /subagents for details)`)}`;
  return textComponent(detail ? `${call}\n${fg(theme, "dim", detail)}` : call);
}
export function renderSubagentRunResult(
  result: any,
  options: any,
  theme: any,
  resultTool = "subagent_result",
  title?: string,
) {
  const task = taskFromDetails(result);
  if (options?.isPartial) {
    const lines = progressText(task, result?.details?.frame ?? 0).split("\n");
    return wrappedTextComponent(
      lines
        .map((line, index) =>
          index === 0 ? fg(theme, "warning", line) : fg(theme, "dim", line),
        )
        .join("\n"),
    );
  }
  const isFailure = failed(task, result);
  if (!task)
    return textComponent(
      fg(
        theme,
        isFailure ? "error" : "dim",
        result?.content?.[0]?.text ?? "No subagent details available.",
      ),
    );
  const status = fg(theme, isFailure ? "error" : "success", task.status);
  const usage = formatUsage(task.usage);
  const summary = [
    `${title ? `${title}: ` : ""}agent: ${fg(theme, "accent", task.agent)} · status: ${status} · attempt: ${fg(theme, "accent", String(task.attempt))} · effort: ${fg(theme, "accent", task.effort)}`,
    fg(theme, "dim", `model: ${modelLabel(task.model)} · id: ${task.id}`),
    usage ? fg(theme, "dim", `usage: ${usage}`) : undefined,
  ]
    .filter(Boolean)
    .join("\n");
  const final = task.result ?? task.error ?? "";
  return textComponent(
    options?.expanded && final
      ? `${summary}\n${fg(theme, "toolTitle", "Subagent response")}\n${final}`
      : `${summary}\n${fg(theme, "dim", `${collapsedResultHint(task, isFailure, resultTool)} · alt+o or /subagents for details`)}`,
  );
}
