import { expect, it } from "vitest";
import { formatAgentRouteLabel, parseCommand, registerCommands } from "../src/commands.js";

const manager = () => ({ config: { profiles: { alpha: { order: 0 } } }, names: () => ["alpha"], setContext() {}, state: { get: () => undefined } });
const piFor = (set: (command: any) => void) => ({ registerCommand: (_: string, command: any) => set(command), events: { emit(_name: string, request: any) { request.setAgents([]); } } });

it("parses profile names and formats textual fallback labels", () => {
  expect(parseCommand("use my review profile")).toEqual({ verb: "use", name: "my review profile" });
  expect(formatAgentRouteLabel(" Reviewer ", { order: 0, defaultRoute: { effort: "high" } })).toContain("reviewer");
});

it("creates entirely in the custom panel without input/select prompts", async () => {
  let command: any; const saves: any[] = []; const seen: any[] = []; let turn = 0;
  registerCommands(piFor((value) => command = value) as any, manager() as any, async (...args: any[]) => { saves.push(args); });
  const ctx: any = { cwd: "/work", isProjectTrusted: () => true, modelRegistry: { getAvailable: () => [] }, sessionManager: { getSessionId: () => "s" }, ui: {
    input: () => { throw new Error("external input must not be called"); }, select: () => { throw new Error("external select must not be called"); }, notify() {}, confirm: async () => true,
    custom: async (factory: any, options: any) => { let emitted: any; const panel = factory({ requestRender() {} }, undefined, undefined, (action: any) => emitted = action); seen.push({ panel, options }); if (turn++ === 0) { const firstRender = panel.render(90).join("\n"); expect(firstRender).toContain("Create profile"); expect(firstRender).toContain("Profile name:"); expect(firstRender).not.toContain("Current assignments:"); for (const key of "draft") panel.handleInput(key); panel.handleInput("\r"); panel.handleInput("\u001b[B"); panel.handleInput("\r"); panel.handleInput("s"); } else panel.handleInput("\u001b"); return emitted; },
  } };
  await command.handler("create", ctx);
  expect(seen[0].options.overlayOptions).toEqual({ anchor: "center", width: "70%", minWidth: 72, maxHeight: "85%" });
  expect(seen[0].panel.projectTrusted).toBe(true); expect(saves[0][1]).toBe("draft"); expect(saves[0][3]).toBe("project");
});

it("uses the internal catalog without an event runtime and falls back to the event when unavailable or thrown", async () => {
let command: any; let emitted = 0; let agents: any[] = [];
const pi: any = { registerCommand: (_: string, value: any) => command = value, events: { emit: () => { emitted++; throw new Error("event must not be used"); } } };
const ctx: any = { cwd: "/work", isProjectTrusted: () => false, modelRegistry: { getAvailable: () => [] }, sessionManager: { getSessionId: () => "s" }, ui: { notify() {}, custom: async (factory: any) => { agents = factory({ requestRender() {} }, undefined, undefined, () => {}).agents; return undefined; } } };
registerCommands(pi, manager() as any, async () => {}, undefined, undefined, () => [{ name: "internal", description: "direct", scope: "global" }]);
await command.handler("", ctx);
expect(agents).toEqual([{ name: "internal", description: "direct", scope: "global" }]);
expect(emitted).toBe(0);

pi.events.emit = (_: string, request: any) => { emitted++; request.setAgents([{ name: "legacy", description: "fallback", scope: "global" }]); };
registerCommands(pi, manager() as any, async () => {}, undefined, undefined, () => undefined);
await command.handler("", ctx);
expect(agents).toEqual([{ name: "legacy", description: "fallback", scope: "global" }]);

registerCommands(pi, manager() as any, async () => {}, undefined, undefined, () => { throw new Error("unavailable"); });
await command.handler("", ctx);
expect(agents).toEqual([{ name: "legacy", description: "fallback", scope: "global" }]);
expect(emitted).toBe(2);
});

it("keeps textual list/status/use/next/off behavior", async () => {
  let command: any; const notices: string[] = []; const calls: string[] = [];
  const stateful: any = { ...manager(), state: { get: () => ({ profile: "one" }) }, use: async (name: string) => calls.push(`use:${name}`), next: async () => calls.push("next"), off: async () => calls.push("off") };
  registerCommands(piFor((value) => command = value) as any, stateful, async () => {});
  const ctx: any = { ui: { notify: (value: string) => notices.push(value) }, sessionManager: { getSessionId: () => "s" } };
  await command.handler("list", ctx); await command.handler("status", ctx); await command.handler("use one", ctx); await command.handler("next", ctx); await command.handler("off", ctx);
  expect(notices).toEqual(["alpha", "one"]); expect(calls).toEqual(["use:one", "next", "off"]);
});

it("reopens after save failure with the same draft session", async () => {
  let command: any; let calls = 0; const notices: string[] = [];
  registerCommands(piFor((value) => command = value) as any, manager() as any, async () => { throw new Error("save failed"); });
  const session = { drafts: { alpha: { order: 0 } }, names: ["alpha"], scopes: {}, dirty: ["alpha"], persisted: ["alpha"], selectedTab: 0, cursor: 0, scroll: 0 };
  const ctx: any = { cwd: "/work", isProjectTrusted: () => false, modelRegistry: { getAvailable: () => [] }, sessionManager: { getSessionId: () => "s" }, ui: { notify: (value: string) => notices.push(value), confirm: async () => true, custom: async () => ++calls === 1 ? { type: "save", name: "alpha", profile: session.drafts.alpha, persisted: true, session } : { type: "close", session } } };
  await command.handler("", ctx); expect(calls).toBe(2); expect(notices).toContain("save failed");
});

it("persists Default in the selected profile scope without activating the session", async () => {
  let command: any; let opens = 0; const saves: any[] = []; const calls: string[] = [];
  const stateful: any = { ...manager(), use: async () => calls.push("use") };
  registerCommands(piFor((value) => command = value) as any, stateful, async (...args: any[]) => { saves.push(args); });
  const session = { drafts: { alpha: { order: 0 } }, names: ["alpha"], scopes: { alpha: "project" }, dirty: [], persisted: ["alpha"], selectedTab: 0, cursor: 0, scroll: 0 };
  const ctx: any = { cwd: "/work", isProjectTrusted: () => true, modelRegistry: { getAvailable: () => [] }, sessionManager: { getSessionId: () => "s" }, ui: { notify() {}, confirm: async () => true, custom: async () => ++opens === 1 ? ({ type: "default", name: "alpha", profile: session.drafts.alpha, persisted: true, session }) : ({ type: "close", session }) } };
  await command.handler("", ctx);
  expect(saves).toEqual([[ctx, "alpha", { order: 0 }, "project", "alpha"]]);
  expect(calls).toEqual([]);
});

it("keeps the effective project default marked after setting a global default", async () => {
  let command: any; let opens = 0; const defaults: Array<string | undefined> = [];
  const stateful: any = {
    ...manager(),
    config: { profiles: { global: { order: 0 }, project: { order: 1 } }, defaultProfile: "project" },
    names: () => ["global", "project"],
  };
  registerCommands(piFor((value) => command = value) as any, stateful, async () => {
    stateful.config.defaultProfile = "project";
  }, undefined, () => ({ global: "global", project: "project" }));
  const ctx: any = { cwd: "/work", isProjectTrusted: () => true, modelRegistry: { getAvailable: () => [] }, sessionManager: { getSessionId: () => "s" }, ui: {
    notify() {}, confirm: async () => true,
    custom: async (factory: any) => {
      const panel = factory({ requestRender() {} }, undefined, undefined, () => {});
      defaults.push(panel.defaultName);
      return ++opens === 1
        ? { type: "default", name: "global", profile: { order: 0 }, persisted: true, session: panel.sessionState() }
        : { type: "close", session: panel.sessionState() };
    },
  } };
  await command.handler("", ctx);
  expect(defaults).toEqual(["project", "project"]);
});

it("marks the revealed global default after deleting the project default", async () => {
  let command: any; let opens = 0; const defaults: Array<string | undefined> = [];
  const stateful: any = {
    ...manager(),
    config: { profiles: { global: { order: 0 }, project: { order: 1 } }, defaultProfile: "project" },
    names: () => ["global", "project"],
  };
  registerCommands(piFor((value) => command = value) as any, stateful, async () => {
    stateful.config.defaultProfile = "global";
  }, undefined, () => ({ global: "global", project: "project" }));
  const ctx: any = { cwd: "/work", isProjectTrusted: () => true, modelRegistry: { getAvailable: () => [] }, sessionManager: { getSessionId: () => "s" }, ui: {
    notify() {}, confirm: async () => true,
    custom: async (factory: any) => {
      const panel = factory({ requestRender() {} }, undefined, undefined, () => {});
      defaults.push(panel.defaultName);
      return ++opens === 1
        ? { type: "delete", name: "project", persisted: true, session: panel.sessionState() }
        : { type: "close", session: panel.sessionState() };
    },
  } };
  await command.handler("", ctx);
  expect(defaults).toEqual(["project", "global"]);
});

it("reopens after activate failure with the same draft session", async () => {
  let command: any; let calls = 0; const notices: string[] = [];
  const failing: any = { ...manager(), use: async () => { throw new Error("activate failed"); } };
  registerCommands(piFor((value) => command = value) as any, failing, async () => {});
  const session = { drafts: { alpha: { order: 0 } }, names: ["alpha"], scopes: {}, dirty: [], persisted: ["alpha"], selectedTab: 0, cursor: 0, scroll: 0 };
  const ctx: any = { cwd: "/work", isProjectTrusted: () => false, modelRegistry: { getAvailable: () => [] }, sessionManager: { getSessionId: () => "s" }, ui: { notify: (value: string) => notices.push(value), confirm: async () => true, custom: async () => ++calls === 1 ? { type: "activate", name: "alpha", profile: session.drafts.alpha, persisted: true, session } : { type: "close", session } } };
  await command.handler("", ctx); expect(calls).toBe(2); expect(notices).toContain("activate failed");
});

it("focuses the exact profile for edit", async () => {
  let command: any; let selected = -1;
  registerCommands(piFor((value) => command = value) as any, manager() as any, async () => {});
  const ctx: any = { cwd: "/work", isProjectTrusted: () => false, modelRegistry: { getAvailable: () => [] }, sessionManager: { getSessionId: () => "s" }, ui: { notify() {}, custom: async (factory: any) => { selected = factory({ requestRender() {} }, undefined, undefined, () => {}).selectedTab; return undefined; } } };
  await command.handler("edit alpha", ctx); expect(selected).toBe(0);
});

it("rejects unknown edit and delete names", async () => {
  let command: any; const notices: string[] = [];
  registerCommands(piFor((value) => command = value) as any, manager() as any, async () => {});
  const ctx: any = { ui: { notify: (message: string) => notices.push(message) } };
  await command.handler("edit missing", ctx); await command.handler("delete missing", ctx);
  expect(notices).toEqual(["Unknown profile: missing", "Unknown profile: missing"]);
});

it("turns an active profile off before deleting it", async () => {
  let command: any; const calls: string[] = [];
  const active: any = { ...manager(), state: { get: () => ({ profile: "alpha" }) }, off: async () => calls.push("off") };
  registerCommands(piFor((value) => command = value) as any, active, async () => { calls.push("save"); });
  const ctx: any = { sessionManager: { getSessionId: () => "s" }, ui: { notify() {}, confirm: async () => true } };
  await command.handler("delete alpha", ctx); expect(calls).toEqual(["off", "save"]);
});

it("does not delete when confirmation is declined", async () => {
  let command: any; const calls: string[] = [];
  registerCommands(piFor((value) => command = value) as any, manager() as any, async () => { calls.push("save"); });
  const ctx: any = { sessionManager: { getSessionId: () => "s" }, ui: { notify() {}, confirm: async () => false } };
  await command.handler("delete alpha", ctx); expect(calls).toEqual([]);
});

it("deletes an inactive profile without turning the manager off", async () => {
  let command: any; const calls: string[] = [];
  const inactive: any = { ...manager(), off: async () => calls.push("off") };
  registerCommands(piFor((value) => command = value) as any, inactive, async () => { calls.push("save"); });
  const ctx: any = { sessionManager: { getSessionId: () => "s" }, ui: { notify() {}, confirm: async () => true } };
  await command.handler("delete alpha", ctx); expect(calls).toEqual(["save"]);
});

it("does not save a delete when turning an active profile off fails", async () => {
  let command: any; const calls: string[] = [];
  const active: any = { ...manager(), state: { get: () => ({ profile: "alpha" }) }, off: async () => { throw new Error("off failed"); } };
  registerCommands(piFor((value) => command = value) as any, active, async () => { calls.push("save"); });
  const ctx: any = { sessionManager: { getSessionId: () => "s" }, ui: { notify: (message: string) => calls.push(message), confirm: async () => true } };
  await command.handler("delete alpha", ctx); expect(calls).toEqual(["off failed"]);
});
