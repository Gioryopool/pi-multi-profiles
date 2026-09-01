import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ProfilePanel, buildRows, renderPanel } from "../src/profile-panel.js";
import type { Profile } from "../src/types.js";

const profiles: Record<string, Profile> = {
  alpha: {
    order: 1,
    defaultRoute: {
      model: { provider: "openai", id: "gpt-5" },
      effort: "high",
    },
  },
  beta: { order: 2 },
};
const agents = [
  { name: " SDD-DESIGN ", description: "", scope: "global" },
  { name: "jd-audit", description: "", scope: "global" },
  { name: "review-code", description: "", scope: "global" },
  { name: "helper", description: "", scope: "global" },
];
const models = [
  { provider: "openai", id: "gpt-5", name: "GPT Five" },
  { provider: "anthropic", id: "claude", name: "Claude" },
];
const input = (panel: ProfilePanel, key: string) => panel.handleInput(key);

function create(panel: ProfilePanel, name: string) {
  input(panel, "n");
  for (const key of name) input(panel, key);
  input(panel, "\r");
  input(panel, "\r");
}

describe("profile assignment panel", () => {
  it("groups normalized catalog agents into named rows", () => {
    const rows = buildRows(profiles.alpha, agents);
    expect(rows.map((row) => row.label)).toEqual([
      "Orchestrator", "Default agents", "SDD phases", "Set all SDD phases",
      "sdd-design", "Judgment Day", "Set all Judgment Day", "jd-audit",
      "Review agents", "Set all Review agents", "review-code", "Other agents",
      "Set all Other agents", "helper",
    ]);
  });

  it("marks only the active session profile in tabs, while retaining dirty and scope state", () => {
    const panel = new ProfilePanel({
      profiles,
      agents,
      scopes: { alpha: "global", beta: "project" },
      activeName: "alpha",
      models,
    });
    panel.dirty.add("beta");
    expect(panel.tabs()).toEqual(["[◆alpha [G]]", " beta ● [P]", "+ new"]);
  });

  it("shows the configured startup default separately from the active profile and emits Default", () => {
    const actions: string[] = [];
    const panel = new ProfilePanel({
      profiles,
      agents,
      scopes: { alpha: "global", beta: "project" },
      activeName: "alpha",
      defaultName: "beta",
      models,
      onAction: (action) => actions.push(action.type),
    });
    expect(panel.tabs()).toEqual(["[◆alpha [G]]", " beta [P]", "+ new"]);
    const text = renderPanel(panel, 90).join("\n");
    expect(text).toContain("Default profile: beta");
    expect(text).toContain("D default");
    input(panel, "d");
    expect(actions).toEqual(["default"]);
  });

  it("renders an explicit missing startup default", () => {
    const panel = new ProfilePanel({ profiles, agents, scopes: {}, models });
    expect(renderPanel(panel, 90).join("\n")).toContain("Default profile: none");
  });

  it("moves the startup default beside current assignments when the heading is too narrow", () => {
    const panel = new ProfilePanel({ profiles, agents, scopes: {}, defaultName: "beta", models });
    const lines = renderPanel(panel, 50);
    expect(lines.find((line) => line.includes("Agent profile assignments"))).not.toContain("Default profile:");
    expect(lines.find((line) => line.includes("Current assignments:"))).toContain("Default profile: beta");
  });

  it("colors only the default-profile segment warning without affecting layout", () => {
    const theme = { fg: (color: string, text: string) => `\u001b[${color === "accent" ? "36" : color === "warning" ? "33" : color === "muted" ? "2" : "0"}m${text}\u001b[0m` } as unknown as ProfilePanel["theme"];
    const panel = new ProfilePanel({ profiles, agents, scopes: {}, defaultName: "beta", models, theme });
    const wide = renderPanel(panel, 90);
    const narrow = renderPanel(panel, 50);
    expect(wide.find((line) => line.includes("Agent profile assignments"))).toContain("\u001b[36mAgent profile assignments • \u001b[0m\u001b[33mDefault profile: beta\u001b[0m");
    expect(narrow.find((line) => line.includes("Current assignments:"))).toContain("\u001b[2mCurrent assignments: • \u001b[0m\u001b[33mDefault profile: beta\u001b[0m");
    expect(wide.every((line) => visibleWidth(line) <= 90)).toBe(true);
    expect(narrow.every((line) => visibleWidth(line) <= 50)).toBe(true);
  });

  it("restores exact tab and cursor from a panel session", () => {
    const panel = new ProfilePanel({ profiles, agents, scopes: {}, models });
    panel.selectedTab = 1;
    panel.cursor = 3;
    panel.scroll = 2;
    const reopened = new ProfilePanel({
      profiles,
      agents,
      scopes: {},
      models,
      session: panel.sessionState(),
    });
    expect([reopened.selectedTab, reopened.cursor, reopened.scroll]).toEqual([1, 3, 2]);
  });

  it("mutates model and effort independently and strips display model names", () => {
    const panel = new ProfilePanel({ profiles: { alpha: { order: 0 } }, agents, scopes: {}, models });
    panel.setRoute("default", "model", models[0]);
    panel.setRoute("default", "effort", "low");
    expect(panel.draft()!.defaultRoute).toEqual({
      model: { provider: "openai", id: "gpt-5" },
      effort: "low",
    });
    panel.removeField("default", "model");
    expect(panel.draft()!.defaultRoute).toEqual({ effort: "low" });
    panel.removeField("default", "effort");
    expect(panel.draft()!.defaultRoute).toBeUndefined();
  });

  it("uses distinct sentinel choices for orchestrator, default, and agents", () => {
    const panel = new ProfilePanel({ profiles, agents, scopes: {}, models });
    expect(panel.choices("model")[0].label).toBe("Inherit session baseline");
    panel.cursor = 1;
    expect(panel.choices("model").slice(0, 2).map((choice) => choice.label)).toEqual([
      "No profile default", "Inherit agent runtime",
    ]);
    panel.cursor = 4;
    expect(panel.choices("effort").slice(0, 2).map((choice) => choice.label)).toEqual([
      "Use profile default", "Inherit agent runtime",
    ]);
  });

  it("renders asymmetric field fallbacks with friendly provider labels", () => {
    const panel = new ProfilePanel({ profiles, agents, scopes: {}, models });
    panel.setRoute("agent", "effort", "low", "helper");
    panel.cursor = 13;
    const text = renderPanel(panel, 90).join("\n");
    expect(text).toContain("OpenAI / GPT Five");
    expect(text).toContain("effort=low");
  });

  it("picker search, backspace, arrows, j/k, selection, and escape replace the body", () => {
    const panel = new ProfilePanel({ profiles, agents, scopes: {}, models });
    input(panel, "m");
    const pickerText = renderPanel(panel, 90).join("\n");
    expect(pickerText).not.toContain("Current assignments:");
    expect(pickerText).toContain("↑/↓/j/k navigate • type search • Enter select • Esc back");
    input(panel, "c");
    expect(panel.pickerChoices()).toHaveLength(1);
    input(panel, "\u007f");
    input(panel, "j");
    expect(panel.picker!.index).toBe(1);
    input(panel, "k");
    expect(panel.picker!.index).toBe(0);
    input(panel, "\u001b[B");
    input(panel, "\r");
    expect(panel.draft()!.orchestrator?.model).toEqual({ provider: "openai", id: "gpt-5" });
    input(panel, "e");
    input(panel, "\u001b");
    expect(renderPanel(panel, 90).join("\n")).toContain("Current assignments:");
  });

  it("opens the model picker with Enter on an assignment row", () => {
    const panel = new ProfilePanel({ profiles, agents, scopes: {}, models });
    panel.cursor = 4;
    input(panel, "\r");
    expect(panel.picker?.field).toBe("model");
  });

  it("movement skips header rows and reset/bulk operations are per-field", () => {
    const panel = new ProfilePanel({ profiles, agents, scopes: {}, models });
    panel.cursor = 1;
    panel.move(1);
    expect(panel.selectedRow().kind).toBe("bulk");
    panel.setRoute("agent", "model", models[0], "sdd-design");
    panel.setRoute("agent", "effort", "high", "sdd-design");
    panel.removeField("agent", "model", "sdd-design");
    expect(panel.draft()!.agents!["sdd-design"]).toEqual({ effort: "high" });
    panel.reset("agent", "sdd-design");
    expect(panel.draft()!.agents!["sdd-design"]).toBeUndefined();
  });

  it("renders a compact rounded card safely at overlay widths without a proportional dead gap", () => {
    const panel = new ProfilePanel({ profiles, agents, scopes: { alpha: "global", beta: "project" }, activeName: "alpha", models });
    panel.setRoute("default", "effort", "low");
    for (const width of [72, 90, 120]) {
      const lines = renderPanel(panel, width);
      const text = lines.join("\n");
      expect(lines[0]).toMatch(/^╭─+╮$/);
      expect(lines.at(-1)).toMatch(/^╰─+╯$/);
      expect(text).toContain("Current assignments:");
      expect(text).toContain("model=");
      expect(text).toContain(", effort=");
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
        const row = renderPanel(panel, 120).find((line) => line.includes("Orchestrator"))!;
        expect(row.indexOf("model=") - row.indexOf("Orchestrator")).toBeLessThan(28);
      });

    it("keeps a fitting assignment model contiguous with its effort", () => {
      const panel = new ProfilePanel({
        profiles: { alpha: { order: 0, defaultRoute: { model: { provider: "openai", id: "gpt-5.4" }, effort: "medium" } } },
        agents,
        scopes: {},
        models: [{ provider: "openai", id: "gpt-5.4", name: "GPT-5.4" }],
      });
      const row = renderPanel(panel, 120).find((line) => line.includes("Default agents"))!;
      expect(row).toContain("model=OpenAI / GPT-5.4, effort=medium");
      expect(row).not.toMatch(/model=OpenAI \/ GPT-5\.4\s+, effort=medium/);
    });

    it("renders inline profile-name mode immediately when requested", () => {
      const panel = new ProfilePanel({ profiles, agents, scopes: {}, models, startInCreate: true });
      const text = renderPanel(panel, 90).join("\n");
      expect(text).toContain("Create profile");
      expect(text).toContain("Profile name:");
      expect(text).not.toContain("Current assignments:");
    });

    it("renders exact grouped navigation help without `or`", () => {
      const panel = new ProfilePanel({ profiles, agents, scopes: {}, models, projectTrusted: true });
      const assignment = renderPanel(panel, 72).join("\n");
      expect(assignment).toContain("↑/↓/j/k navigate • Enter/M model • E effort • Tab profiles");
      expect(assignment).toContain("R reset • S save • A activate • D default");
      expect(assignment).toContain("N new • Del remove • Esc/Q close");
      expect(assignment).not.toContain(" or ");
      input(panel, "m");
      expect(renderPanel(panel, 90).join("\n")).toContain("↑/↓/j/k navigate • type search • Enter select • Esc back");
      input(panel, "\u001b");
      input(panel, "e");
      expect(renderPanel(panel, 90).join("\n")).toContain("↑/↓/j/k navigate • Enter select • Esc back");
      input(panel, "\u001b");
      input(panel, "n");
      input(panel, "x");
      input(panel, "\r");
      expect(renderPanel(panel, 90).join("\n")).toContain("↑/↓/j/k select • Enter create • Esc back");
    });

    it("keeps assignment labels fixed and colors each themed segment safely", () => {
      const theme = { fg: (color: string, text: string) => `\u001b[${color === "accent" ? "36" : color === "success" ? "32" : color === "muted" ? "2" : "0"}m${text}\u001b[0m` } as unknown as ProfilePanel["theme"];
      const panel = new ProfilePanel({ profiles, agents, scopes: {}, models, theme });
      const rowAt = (width: number) => renderPanel(panel, width).find((line) => line.includes("Orchestrator"))!;
      const narrow = rowAt(72);
      const wide = rowAt(120);
      expect(narrow.indexOf("model=") - narrow.indexOf("Orchestrator")).toBe(wide.indexOf("model=") - wide.indexOf("Orchestrator"));
      expect(narrow).toContain("\u001b[36m▸\u001b[0m");
      expect(narrow).toContain("\u001b[2m model=\u001b[0m");
      expect(wide).toContain("\u001b[32msession baseline\u001b[0m\u001b[2m, effort=\u001b[0m\u001b[32msession baseline\u001b[0m");
      expect(narrow).not.toMatch(/model=.*\s+, effort=/);
      expect(renderPanel(panel, 72).every((line) => visibleWidth(line) <= 72)).toBe(true);
    });

    it("creates drafts inline from any tab and resets scope to global for each new creation", () => {
    const panel = new ProfilePanel({ profiles, agents, scopes: {}, models, projectTrusted: true });
    input(panel, "n");
    expect(panel.create).toBe("name");
    for (const key of "first") input(panel, key);
    input(panel, "\r");
    input(panel, "\u001b[B");
    input(panel, "\r");
    expect(panel.scopes.first).toBe("project");
    input(panel, "n");
    for (const key of "second") input(panel, key);
    input(panel, "\r");
    expect(panel.createScope).toBe("global");
    input(panel, "\r");
    expect(panel.scopes.second).toBe("global");
  });

  it("validates inline creation, gates project scope, and preserves scope selection on scope escape", () => {
    const panel = new ProfilePanel({ profiles, agents, scopes: {}, models, projectTrusted: false });
    input(panel, "n");
    input(panel, "\r");
    expect(renderPanel(panel, 90).join("\n")).toContain("Profile name is required");
    for (const key of "alpha") input(panel, key);
    input(panel, "\r");
    expect(renderPanel(panel, 90).join("\n")).toContain("Profile already exists");
    input(panel, "\u001b");
    input(panel, "n");
    for (const key of "fresh") input(panel, key);
    input(panel, "\r");
    expect(renderPanel(panel, 90).join("\n")).not.toContain("Project");
  });

  it("emits save, activate, delete, and close without deleting the new tab", () => {
    const actions: string[] = [];
    const panel = new ProfilePanel({ profiles, agents, scopes: {}, models, onAction: (action) => actions.push(action.type) });
    input(panel, "s"); input(panel, "a"); input(panel, "\u001b[3~"); input(panel, "\u001b");
    panel.selectedTab = panel.names.length;
    input(panel, "\u001b[3~");
    expect(actions).toEqual(["save", "activate", "delete", "close"]);
  });

  it("closes the assignment view with lowercase and uppercase q", () => {
    const actions: string[] = [];
    const panel = new ProfilePanel({ profiles, agents, scopes: {}, models, onAction: (action) => actions.push(action.type) });
    input(panel, "q");
    input(panel, "Q");
    expect(actions).toEqual(["close", "close"]);
  });

  it("keeps q as text while entering names and searching models", () => {
    const panel = new ProfilePanel({ profiles, agents, scopes: {}, models });
    input(panel, "n");
    input(panel, "q");
    expect(panel.createName).toBe("q");
    input(panel, "\u001b");
    input(panel, "m");
    input(panel, "q");
    expect(panel.picker?.search).toBe("q");
  });
});
