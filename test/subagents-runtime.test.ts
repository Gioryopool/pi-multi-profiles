import { describe, expect, it } from "vitest";
import {
  discoverAgents,
  readCompatibleSubagentsConfig,
  type RuntimeFileSystem,
} from "../src/subagents-runtime/discovery.js";
import {
  claimRuntimeOwner,
  releaseRuntimeOwner,
} from "../src/subagents-runtime/ownership.js";

function files(entries: Record<string, string>): RuntimeFileSystem {
  return {
    exists: (path) =>
      Object.hasOwn(entries, path) ||
      Object.keys(entries).some((file) => file.startsWith(`${path}/`)),
    readFile: (path) => entries[path],
    readDir: (path) =>
      Object.keys(entries)
        .filter((file) => file.startsWith(`${path}/`))
        .map((file) => file.slice(path.length + 1))
        .filter((file) => !file.includes("/")),
  };
}

const input = (entries: Record<string, string>, projectTrusted = true) => ({
  fs: files(entries),
  agentDir: "/global",
  cwd: "/project",
  projectTrusted,
});
const markdown = (name: string, description = "description") =>
  `---\nname: ${name}\ndescription: ${description}\ntools:\n  - read\n---\nInstructions`;

describe("internal subagent runtime discovery", () => {
  it("uses project over global and subagents over agents precedence", () => {
    const result = discoverAgents(
      input({
        "/global/agents/research.md": markdown("research", "global agents"),
        "/global/subagents/research.md": markdown(
          "research",
          "global subagents",
        ),
        "/project/.pi/agents/research.md": markdown(
          "research",
          "project agents",
        ),
        "/project/.pi/subagents/research.md": markdown(
          "Research",
          "project subagents",
        ),
      }),
    );
    expect(result.catalog).toEqual([
      { name: "research", description: "project subagents", scope: "project" },
    ]);
    expect(result.definitions.research.instructions).toBe("Instructions");
    expect(result.diagnostics).toHaveLength(3);
  });

  it("does not inspect project paths when the project is untrusted", () => {
    const fs = files({
      "/global/agents/global.md": markdown("global"),
      "/project/.pi/agents/private.md": markdown("private"),
    });
    const reads: string[] = [];
    const result = discoverAgents({
      ...input({}, false),
      fs: {
        ...fs,
        exists(path) {
          reads.push(path);
          return fs.exists(path);
        },
      },
    });
    expect(result.catalog).toEqual([
      { name: "global", description: "description", scope: "global" },
    ]);
    expect(reads.some((path) => path.startsWith("/project/.pi"))).toBe(false);
  });

  it("fails malformed and duplicate-case definitions safely with diagnostics", () => {
    const result = discoverAgents(
      input({
        "/global/agents/one.md":
          "---\nname: One\ntools: read\ntools:\n - bash\n---\nbody",
        "/global/agents/two.md": markdown("TWO"),
        "/global/subagents/three.md": markdown("two"),
      }),
    );
    expect(result.catalog).toEqual([
      { name: "two", description: "description", scope: "global" },
    ]);
    expect(
      result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
    ).toMatch(/ambiguous|duplicate/i);
  });

  it("matches reference frontmatter scalars, delimiters, defaults, modes, aliases, and recursive-tool filtering", () => {
    const result = discoverAgents(
      input({
        "/global/agents/alpha.md":
          "---\r\nname: ' Alpha '\r\ndescription: \"quoted\"\r\ntools: read, subagent_run, 'memory_search'\r\neffort: high\r\nsubagent_mode: background\r\nretries: 2\r\nenabled: true\r\n---\r\nInstructions",
        "/global/agents/default.md":
          "---\nname: default\ntools:\n  - read\n  - subagent_status\n  - memory_get\n---\nBody",
      }),
    );
    expect(result.definitions.alpha).toMatchObject({
      name: "alpha",
      description: "quoted",
      effort: "high",
      subagent_mode: "background",
      tools: ["read", "memory_search"],
    });
    expect(result.definitions.default.tools).toEqual(["read", "memory_get"]);
    expect(
      discoverAgents(
        input({
          "/global/agents/no-tools.md": "---\nname: no-tools\n---\nBody",
        }),
      ).definitions["no-tools"].tools,
    ).toEqual([
      "read",
      "memory_context",
      "memory_search",
      "memory_recall",
      "memory_get",
    ]);
    expect(
      discoverAgents(
        input({
          "/global/agents/alias.md":
            "---\nname: alias\nthinkingLevel: xhigh\n---\nBody",
        }),
      ).definitions.alias.effort,
    ).toBe("xhigh");
  });

  it("blocks invalid high-precedence definitions and unreadable files over lower definitions", () => {
    const base = files({
      "/global/agents/same.md": markdown("same", "lower"),
      "/global/subagents/same.md":
        "---\nname: same\nsubagent_mode: later\n---\nBody",
      "/global/agents/unreadable.md": markdown("unreadable"),
    });
    const result = discoverAgents({
      ...input({}),
      fs: {
        ...base,
        readFile(path) {
          return path.endsWith("unreadable.md")
            ? undefined
            : base.readFile(path);
        },
      },
    });
    expect(result.definitions.same).toBeUndefined();
    expect(result.definitions.unreadable).toBeUndefined();
    expect(result.diagnostics.map((item) => item.message).join("\n")).toMatch(
      /subagent_mode|unreadable/i,
    );
  });

  it("applies numeric defaults, validates positives, filters recursive defaults, and gates project overrides by trust", () => {
    const entries = {
      "/global/subagents.json": JSON.stringify({
        timeout_ms: 10,
        stall_timeout_ms: 20,
        max_concurrency: 2,
        default_tools: ["read", "subagent_run"],
        session_resources: "full",
        default_mode: "background",
      }),
      "/project/.pi/subagents.json": JSON.stringify({
        timeout_ms: 30,
        stall_timeout_ms: 0,
        max_concurrency: -1,
        default_tools: ["memory_get", "agent_profiles_subagent_run"],
        session_resources: "lean",
        default_mode: "task",
      }),
    };
    const trusted = readCompatibleSubagentsConfig(input(entries));
    expect(trusted).toMatchObject({
      timeoutMs: 30,
      stallTimeoutMs: 20,
      maxConcurrency: 2,
      defaultTools: ["memory_get"],
      sessionResources: "lean",
      defaultMode: "task",
    });
    expect(trusted.diagnostics.map((item) => item.message).join(" ")).toMatch(
      /positive integer/,
    );
    const untrusted = readCompatibleSubagentsConfig(input(entries, false));
    expect(untrusted).toMatchObject({
      timeoutMs: 10,
      stallTimeoutMs: 20,
      maxConcurrency: 2,
      defaultTools: ["read"],
      sessionResources: "full",
      defaultMode: "background",
    });
    expect(readCompatibleSubagentsConfig(input({}))).toMatchObject({
      timeoutMs: 1_200_000,
      stallTimeoutMs: 240_000,
      maxConcurrency: 5,
      sessionResources: "lean",
      defaultMode: "task",
      enableContinue: true,
    });
    expect(
      readCompatibleSubagentsConfig(
        input({
          "/global/subagents.json": JSON.stringify({ enable_continue: false }),
        }),
      ),
    ).toMatchObject({ enableContinue: false });
    expect(
      readCompatibleSubagentsConfig(
        input({
          "/global/subagents.json": JSON.stringify({ enable_continue: false }),
          "/project/.pi/subagents.json": JSON.stringify({
            enable_continue: true,
          }),
        }),
      ),
    ).toMatchObject({ enableContinue: true });
  });

  it("normalizes the old global history shortcut and accepts only alt+o", () => {
    const accepted = readCompatibleSubagentsConfig(
      input({
        "/global/subagents.json": JSON.stringify({
          history_panel_shortcut: "ctrl+,",
        }),
      }),
    );
    expect(accepted.historyPanelShortcut).toBe("alt+o");
    const invalid = readCompatibleSubagentsConfig(
      input({
        "/global/subagents.json": JSON.stringify({
          history_panel_shortcut: "ctrl+shift+o",
        }),
      }),
    );
    expect(invalid.historyPanelShortcut).toBe("alt+o");
    expect(invalid.diagnostics.map((item) => item.message)).toContain(
      "subagents.json history_panel_shortcut is unsupported; only alt+o is globally effective",
    );
  });

  it("reads compatible config aliases, object models, scoped profiles, and malformed-shape diagnostics", () => {
    const result = readCompatibleSubagentsConfig(
      input({
        "/global/subagents.json": JSON.stringify({
          default_model: { provider: "openai", id: "gpt" },
          default_thinking_level: "medium",
          model_profiles: { Alpha: { thinking_level: "high" } },
        }),
        "/project/.pi/subagents.json": JSON.stringify({
          thinkingLevel: "low",
          model_profiles: {
            alpha: {
              model: { provider: "anthropic", id: "claude" },
              thinkingLevel: "xhigh",
            },
          },
        }),
      }),
    );
    expect(result.defaultModel).toEqual({ provider: "openai", id: "gpt" });
    expect(result.defaultEffort).toBe("low");
    expect(result.globalModelProfiles.alpha).toEqual({ effort: "high" });
    expect(result.projectModelProfiles.alpha).toEqual({
      model: { provider: "anthropic", id: "claude" },
      effort: "xhigh",
    });
    const malformed = readCompatibleSubagentsConfig(
      input({
        "/global/subagents.json": "not json",
        "/project/.pi/subagents.json": JSON.stringify({ model_profiles: [] }),
      }),
    );
    expect(
      malformed.diagnostics.map((item) => item.message).join("\n"),
    ).toMatch(/JSON|model_profiles/i);
    expect(
      readCompatibleSubagentsConfig(
        input(
          {
            "/global/subagents.json": "{}",
            "/project/.pi/subagents.json": "not json",
          },
          false,
        ),
      ).projectModelProfiles,
    ).toEqual({});
  });
});

describe("runtime ownership", () => {
  it("claims, diagnoses conflicts, and releases without registering tools", () => {
    const globalObject = {} as Record<PropertyKey, unknown>;
    const first = claimRuntimeOwner({ id: "first" }, globalObject);
    const second = claimRuntimeOwner({ id: "second" }, globalObject);
    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(false);
    expect(second.diagnostic).toMatch(/first/);
    expect(second.toolNamespace).toBe("agent_profiles_subagent_");
    releaseRuntimeOwner(first, globalObject);
    expect(claimRuntimeOwner({ id: "second" }, globalObject).claimed).toBe(
      true,
    );
  });
});
