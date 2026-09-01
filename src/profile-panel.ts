import { Key, matchesKey, parseKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { type Theme } from "@earendil-works/pi-coding-agent";
import { normalizeAgent } from "./config.js";
import type { CatalogAgent, ModelRef, PersistedRoute, Profile, ThinkingLevel } from "./types.js";

export type PanelRowKind = "orchestrator" | "default" | "header" | "bulk" | "agent";
export type PanelRow = { kind: PanelRowKind; label: string; group?: string; agent?: string };
export type PanelSessionState = { drafts: Record<string, Profile>; names: string[]; scopes: Record<string, "global" | "project">; dirty: string[]; persisted: string[]; defaultName?: string; selectedTab: number; cursor: number; scroll: number };
export type PanelAction = { type: "save" | "activate" | "default" | "delete" | "close"; name?: string; profile?: Profile; session: PanelSessionState; persisted?: boolean };
type Field = "model" | "effort";
type Choice = { label: string; value: PersistedRoute[Field] | undefined };
type Picker = { field: Field; index: number; search: string };
type CreateMode = "name" | "scope";

const EFFORTS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const groups = [
  ["SDD phases", (name: string) => name.startsWith("sdd-")],
  ["Judgment Day", (name: string) => name.startsWith("jd-")],
  ["Review agents", (name: string) => name.startsWith("review-")],
] as const;
const clone = <T>(value: T): T => structuredClone(value);
const own = (route: PersistedRoute | undefined, field: Field) => !!route && Object.hasOwn(route, field);
const providerLabel = (provider: string) => provider === "openai-codex" || provider === "openai" ? "OpenAI" : provider === "anthropic" ? "Anthropic" : provider.startsWith("google") ? "Google" : provider.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
const isText = (data: string) => {
  const text = parseKey(data);
  return text?.length === 1 && !/\p{C}/u.test(text) ? text : undefined;
};

export function buildRows(_profile: Profile, agents: CatalogAgent[]): PanelRow[] {
  const rows: PanelRow[] = [
    { kind: "orchestrator", label: "Orchestrator" },
    { kind: "default", label: "Default agents" },
  ];
  const pending = agents.map((agent) => normalizeAgent(agent.name));
  for (const [group, matches] of groups) {
    const names = pending.filter(matches);
    if (!names.length) continue;
    rows.push({ kind: "header", label: group, group }, { kind: "bulk", label: `Set all ${group}`, group });
    rows.push(...names.map((agent) => ({ kind: "agent" as const, label: agent, group, agent })));
    names.forEach((name) => pending.splice(pending.indexOf(name), 1));
  }
  if (pending.length) {
    const group = "Other agents";
    rows.push({ kind: "header", label: group, group }, { kind: "bulk", label: `Set all ${group}`, group });
    rows.push(...pending.map((agent) => ({ kind: "agent" as const, label: agent, group, agent })));
  }
  return rows;
}

export type ProfilePanelOptions = { profiles: Record<string, Profile>; agents: CatalogAgent[]; scopes: Record<string, "global" | "project">; activeName?: string; defaultName?: string; models: (ModelRef & { name?: string })[]; focusName?: string; session?: PanelSessionState; startInCreate?: boolean; theme?: Theme; requestRender?: () => void; onAction?: (action: PanelAction) => void; projectTrusted?: boolean };

export class ProfilePanel implements Component {
  readonly drafts: Record<string, Profile>;
  readonly names: string[];
  readonly agents: CatalogAgent[];
  readonly scopes: Record<string, "global" | "project">;
  readonly models: (ModelRef & { name?: string })[];
  readonly dirty: Set<string>;
  readonly persisted: Set<string>;
  readonly activeName?: string;
  readonly defaultName?: string;
  readonly theme?: Theme;
  readonly requestRender?: () => void;
  readonly onAction?: (action: PanelAction) => void;
  readonly projectTrusted: boolean;
  selectedTab: number;
  cursor: number;
  scroll: number;
  picker?: Picker;
  create?: CreateMode;
  createName = "";
  createCursor = 0;
  createScope: "global" | "project" = "global";
  createError?: string;

  constructor(options: ProfilePanelOptions) {
    const state = options.session;
    this.drafts = clone(state?.drafts ?? options.profiles);
    this.names = [...(state?.names ?? Object.entries(options.profiles).sort((a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0])).map(([name]) => name))];
    this.scopes = { ...options.scopes, ...state?.scopes };
    this.agents = options.agents;
    this.models = options.models;
    this.dirty = new Set(state?.dirty);
    this.persisted = new Set(state?.persisted ?? Object.keys(options.profiles));
    this.activeName = options.activeName;
    this.defaultName = state?.defaultName ?? options.defaultName;
    this.theme = options.theme;
    this.requestRender = options.requestRender;
    this.onAction = options.onAction;
    this.projectTrusted = !!options.projectTrusted;
    this.selectedTab = Math.max(0, state?.selectedTab ?? (options.focusName ? this.names.indexOf(options.focusName) : 0));
    this.cursor = state?.cursor ?? 0;
    this.scroll = state?.scroll ?? 0;
    if (options.startInCreate) this.create = "name";
  }

  sessionState(): PanelSessionState { return { drafts: clone(this.drafts), names: [...this.names], scopes: { ...this.scopes }, dirty: [...this.dirty], persisted: [...this.persisted], defaultName: this.defaultName, selectedTab: this.selectedTab, cursor: this.cursor, scroll: this.scroll }; }
  tabs() { return [...this.names.map((name, index) => `${index === this.selectedTab ? "[" : " "}${name === this.activeName ? "◆" : ""}${name}${this.dirty.has(name) ? " ●" : ""} [${this.scopes[name] === "project" ? "P" : "G"}]${index === this.selectedTab ? "]" : ""}`), `${this.selectedTab === this.names.length ? "[+ new]" : "+ new"}`]; }
  name() { return this.names[this.selectedTab]; }
  draft(name = this.name()) { return name ? this.drafts[name] : undefined; }
  rows() { const profile = this.draft(); return profile ? buildRows(profile, this.agents) : []; }
  selectedRow() { return this.rows()[this.cursor] ?? { kind: "header" as const, label: "" }; }
  private redraw() { this.requestRender?.(); }
  private changed() { if (this.name()) this.dirty.add(this.name()!); this.redraw(); }
  private emit(type: PanelAction["type"]) { const name = this.name(); this.onAction?.({ type, name, profile: name ? clone(this.drafts[name]) : undefined, persisted: !!name && this.persisted.has(name), session: this.sessionState() }); }

  setRoute(target: "orchestrator" | "default" | "agent", field: Field, value: PersistedRoute[Field], agent?: string) {
    const profile = this.draft();
    if (!profile) return;
    const clean = field === "model" && value && typeof value === "object" ? { provider: value.provider, id: value.id } : value;
    if (target === "orchestrator") profile.orchestrator = { ...profile.orchestrator, [field]: clean };
    else if (target === "default") profile.defaultRoute = { ...profile.defaultRoute, [field]: clean };
    else { profile.agents ??= {}; const name = normalizeAgent(agent!); profile.agents[name] = { ...profile.agents[name], [field]: clean }; }
    this.changed();
  }

  removeField(target: "orchestrator" | "default" | "agent", field: Field, agent?: string) {
    const profile = this.draft();
    if (!profile) return;
    const key = target === "orchestrator" ? "orchestrator" : target === "default" ? "defaultRoute" : undefined;
    const route = key ? profile[key] : profile.agents?.[normalizeAgent(agent!)];
    if (!route) return;
    delete route[field];
    if (!Object.keys(route).length) key ? delete profile[key] : delete profile.agents?.[normalizeAgent(agent!)];
    this.changed();
  }

  reset(target: "orchestrator" | "default" | "agent", agent?: string) {
    const profile = this.draft();
    if (!profile) return;
    if (target === "orchestrator") delete profile.orchestrator;
    else if (target === "default") delete profile.defaultRoute;
    else delete profile.agents?.[normalizeAgent(agent!)];
    this.changed();
  }

  applyBulk(row: PanelRow, field: Field, value: PersistedRoute[Field] | undefined) {
    for (const agent of this.rows().filter((item) => item.kind === "agent" && item.group === row.group)) {
      if (value === undefined) this.removeField("agent", field, agent.agent);
      else this.setRoute("agent", field, value, agent.agent);
    }
  }

  choices(field: Field): Choice[] {
    const row = this.selectedRow();
    const explicit = field === "model" ? this.models.map((model) => ({ label: `${providerLabel(model.provider)} / ${model.name ?? model.id}`, value: model })) : EFFORTS.map((effort) => ({ label: effort, value: effort }));
    if (row.kind === "orchestrator") return [{ label: "Inherit session baseline", value: field === "model" ? null : "inherit" }, ...explicit];
    if (row.kind === "default") return [{ label: "No profile default", value: undefined }, { label: "Inherit agent runtime", value: field === "model" ? null : "inherit" }, ...explicit];
    return [{ label: "Use profile default", value: undefined }, { label: "Inherit agent runtime", value: field === "model" ? null : "inherit" }, ...explicit];
  }
  pickerChoices() { const picker = this.picker!; return this.choices(picker.field).filter((choice) => !picker.search || choice.label.toLowerCase().includes(picker.search)); }
  private choose() {
    const picker = this.picker!;
    const row = this.selectedRow();
    const choice = this.pickerChoices()[picker.index];
    if (!choice) return;
    if (row.kind === "bulk") this.applyBulk(row, picker.field, choice.value);
    else if (row.kind !== "header") {
      const target = row.kind === "orchestrator" ? "orchestrator" : row.kind === "default" ? "default" : "agent";
      if (choice.value === undefined) this.removeField(target, picker.field, row.agent);
      else this.setRoute(target, picker.field, choice.value, row.agent);
    }
    this.picker = undefined;
    this.redraw();
  }

  move(delta: number) { const rows = this.rows(); if (!rows.length) return; let next = this.cursor; do next = (next + delta + rows.length) % rows.length; while (rows[next].kind === "header"); this.cursor = next; this.redraw(); }
  private tab(delta: number) { this.selectedTab = (this.selectedTab + delta + this.names.length + 1) % (this.names.length + 1); this.cursor = this.scroll = 0; this.redraw(); }
  openPicker(field: Field) { if (this.selectedRow().kind !== "header") { this.picker = { field, index: 0, search: "" }; this.redraw(); } }
  private startCreate() { this.create = "name"; this.createName = ""; this.createCursor = 0; this.createScope = "global"; this.createError = undefined; this.redraw(); }

  private inputName(data: string) {
    if (matchesKey(data, "ctrl+c")) return this.emit("close");
    if (matchesKey(data, Key.escape)) { this.create = undefined; return this.redraw(); }
    if (matchesKey(data, Key.left)) this.createCursor = Math.max(0, this.createCursor - 1);
    else if (matchesKey(data, Key.right)) this.createCursor = Math.min(this.createName.length, this.createCursor + 1);
    else if (matchesKey(data, Key.home)) this.createCursor = 0;
    else if (matchesKey(data, Key.end)) this.createCursor = this.createName.length;
    else if (matchesKey(data, Key.backspace)) { if (this.createCursor) { this.createName = this.createName.slice(0, this.createCursor - 1) + this.createName.slice(this.createCursor); this.createCursor--; } }
    else if (matchesKey(data, Key.enter)) { const name = this.createName.trim(); this.createError = !name ? "Profile name is required" : this.drafts[name] ? "Profile already exists" : undefined; if (!this.createError) this.create = "scope"; }
    else { const text = isText(data); if (text) { this.createName = this.createName.slice(0, this.createCursor) + text + this.createName.slice(this.createCursor); this.createCursor++; this.createError = undefined; } }
    this.redraw();
  }

  private inputScope(data: string) {
    if (matchesKey(data, "ctrl+c")) return this.emit("close");
    if (matchesKey(data, Key.escape)) { this.create = "name"; return this.redraw(); }
    if (this.projectTrusted && (matchesKey(data, Key.up) || matchesKey(data, Key.down) || matchesKey(data, "j") || matchesKey(data, "k"))) this.createScope = this.createScope === "global" ? "project" : "global";
    if (matchesKey(data, Key.enter)) { const name = this.createName.trim(); this.drafts[name] = { order: Math.max(-1, ...Object.values(this.drafts).map((profile) => profile.order)) + 1, agents: {} }; this.names.push(name); this.scopes[name] = this.createScope; this.dirty.add(name); this.selectedTab = this.names.length - 1; this.cursor = this.scroll = 0; this.create = undefined; }
    this.redraw();
  }

  handleInput(data: string) {
    if (this.create === "name") return this.inputName(data);
    if (this.create === "scope") return this.inputScope(data);
    if (this.picker) {
      const choices = this.pickerChoices();
      if (matchesKey(data, Key.escape)) this.picker = undefined;
      else if (matchesKey(data, Key.enter)) return this.choose();
      else if (matchesKey(data, Key.backspace)) { this.picker.search = this.picker.search.slice(0, -1); this.picker.index = 0; }
      else if ((matchesKey(data, Key.up) || matchesKey(data, "k")) && choices.length) this.picker.index = (this.picker.index + choices.length - 1) % choices.length;
      else if ((matchesKey(data, Key.down) || matchesKey(data, "j")) && choices.length) this.picker.index = (this.picker.index + 1) % choices.length;
      else { const text = isText(data); if (text) { this.picker.search += text.toLowerCase(); this.picker.index = 0; } }
      return this.redraw();
    }
    if (matchesKey(data, Key.tab)) return this.tab(1);
    if (matchesKey(data, Key.shift("tab"))) return this.tab(-1);
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) return this.move(-1);
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) return this.move(1);
    if (!this.name() && (matchesKey(data, Key.enter) || matchesKey(data, "s") || matchesKey(data, Key.shift("s")) || matchesKey(data, "a") || matchesKey(data, Key.shift("a")) || matchesKey(data, "n") || matchesKey(data, Key.shift("n")))) return this.startCreate();
    if (matchesKey(data, "n") || matchesKey(data, Key.shift("n"))) return this.startCreate();
    const row = this.selectedRow();
    if (matchesKey(data, Key.enter) && row.kind !== "header") return this.openPicker("model");
    if (matchesKey(data, "m") || matchesKey(data, Key.shift("m"))) return this.openPicker("model");
    if (matchesKey(data, "e") || matchesKey(data, Key.shift("e"))) return this.openPicker("effort");
    if (matchesKey(data, "r") || matchesKey(data, Key.shift("r"))) { if (row.kind === "bulk") { this.applyBulk(row, "model", undefined); this.applyBulk(row, "effort", undefined); } else if (row.kind !== "header") this.reset(row.kind === "orchestrator" ? "orchestrator" : row.kind === "default" ? "default" : "agent", row.agent); return; }
    if (matchesKey(data, "s") || matchesKey(data, Key.shift("s"))) return this.emit("save");
    if (matchesKey(data, "a") || matchesKey(data, Key.shift("a"))) return this.emit("activate");
    if ((matchesKey(data, "d") || matchesKey(data, Key.shift("d"))) && this.name()) return this.emit("default");
    if (matchesKey(data, Key.delete) && this.name()) return this.emit("delete");
    if (matchesKey(data, Key.escape) || matchesKey(data, "q") || matchesKey(data, Key.shift("q"))) this.emit("close");
  }
  invalidate() { this.redraw(); }
  render(width: number) { return renderPanel(this, width); }
}

const tone = (panel: ProfilePanel, color: Parameters<Theme["fg"]>[0], text: string) => panel.theme?.fg(color, text) ?? text;
const clip = (text: string, width: number) => truncateToWidth(text, Math.max(1, width), "…", false);
const pad = (text: string, width: number) => `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
function detail(panel: ProfilePanel, row: PanelRow, field: Field) { const profile = panel.draft()!; const route = row.kind === "orchestrator" ? profile.orchestrator : row.kind === "default" ? profile.defaultRoute : row.kind === "agent" ? profile.agents?.[row.agent!] : undefined; const fallback = row.kind === "agent" ? profile.defaultRoute : undefined; const value = own(route, field) ? route?.[field] : own(fallback, field) ? fallback?.[field] : undefined; if (field === "model") return value && typeof value === "object" ? `${providerLabel(value.provider)} / ${panel.models.find((model) => model.provider === value.provider && model.id === value.id)?.name ?? value.id}` : row.kind === "orchestrator" ? "session baseline" : "inherit runtime"; return typeof value === "string" && value !== "inherit" ? value : row.kind === "orchestrator" ? "session baseline" : "inherit runtime"; }
function bulk(panel: ProfilePanel, row: PanelRow, field: Field) { const values = panel.rows().filter((item) => item.kind === "agent" && item.group === row.group).map((item) => detail(panel, item, field)); return values.length && values.every((value) => value === values[0]) ? values[0] : "mixed"; }
    function assignment(panel: ProfilePanel, row: PanelRow, width: number, selected: boolean) {
      const labelWidth = 21;
      const model = row.kind === "bulk" ? bulk(panel, row, "model") : detail(panel, row, "model");
      const effort = row.kind === "bulk" ? bulk(panel, row, "effort") : detail(panel, row, "effort");
      const cursor = selected ? tone(panel, "accent", "▸") : " ";
      const label = tone(panel, "text", pad(clip(row.label, labelWidth), labelWidth));
      const modelLiteral = tone(panel, "muted", " model=");
      const effortLiteral = tone(panel, "muted", ", effort=");
      const clippedModel = clip(model, Math.max(1, width - 2 - labelWidth - visibleWidth(" model=") - visibleWidth(", effort=") - visibleWidth(effort)));
      return `${cursor} ${label}${modelLiteral}${tone(panel, "success", clippedModel)}${effortLiteral}${tone(panel, "success", effort)}`;
    }
function card(lines: string[], width: number) { const inner = Math.max(1, width - 4); return [`╭${"─".repeat(inner + 2)}╮`, ...lines.map((line) => `│ ${pad(clip(line, inner), inner)} │`), `╰${"─".repeat(inner + 2)}╯`]; }
function picker(panel: ProfilePanel) { const state = panel.picker!; const choices = panel.pickerChoices(); const start = Math.max(0, Math.min(state.index - 3, Math.max(0, choices.length - 7))); const title = `Select ${state.field} for ${panel.selectedRow().label}`; return [tone(panel, "accent", title), "", state.field === "model" ? `◎ ${state.search || "search..."}` : "", "", ...choices.slice(start, start + 7).map((choice, index) => `${start + index === state.index ? "▸" : " "} ${choice.label}`), "", tone(panel, "muted", state.field === "model" ? "↑/↓/j/k navigate • type search • Enter select • Esc back" : "↑/↓/j/k navigate • Enter select • Esc back")]; }
function create(panel: ProfilePanel) { if (panel.create === "name") return [tone(panel, "accent", "Create profile"), "", "Profile name:", `${panel.createName.slice(0, panel.createCursor)}▏${panel.createName.slice(panel.createCursor)}`, panel.createError ? tone(panel, "error", panel.createError) : "", "", tone(panel, "muted", "Enter: continue • Esc: back")]; return [tone(panel, "accent", "Create profile"), "", "Choose profile scope:", `${panel.createScope === "global" ? "▸" : " "} Global`, ...(panel.projectTrusted ? [`${panel.createScope === "project" ? "▸" : " "} Project`] : []), "", tone(panel, "muted", "↑/↓/j/k select • Enter create • Esc back")]; }
export function renderPanel(panel: ProfilePanel, width: number): string[] { if (width < 4) return [clip("", width)]; const inner = Math.max(1, width - 4); if (panel.create) return card(create(panel), width); if (panel.picker) return card(picker(panel), width); const rows = panel.rows(); const defaultProfile = `Default profile: ${panel.defaultName ?? "none"}`; const title = "Agent profile assignments"; const heading = `${title} • ${defaultProfile}`; const headingFits = visibleWidth(heading) <= inner; const headingLine = headingFits ? `${tone(panel, "accent", `${title} • `)}${tone(panel, "warning", defaultProfile)}` : tone(panel, "accent", title); const assignmentsLine = headingFits ? tone(panel, "muted", "Current assignments:") : `${tone(panel, "muted", "Current assignments: • ")}${tone(panel, "warning", defaultProfile)}`; const lines = [headingLine, tabLine(panel, inner), "", assignmentsLine, ""]; const height = 8; panel.scroll = Math.max(0, Math.min(panel.scroll, Math.max(0, rows.length - height))); if (panel.cursor < panel.scroll) panel.scroll = panel.cursor; if (panel.cursor >= panel.scroll + height) panel.scroll = panel.cursor - height + 1; if (panel.scroll) lines.push(tone(panel, "muted", "  ↑ more")); for (let index = panel.scroll; index < Math.min(rows.length, panel.scroll + height); index++) lines.push(rows[index].kind === "header" ? tone(panel, "muted", `  ${rows[index].label}`) : assignment(panel, rows[index], inner, index === panel.cursor)); if (panel.scroll + height < rows.length) lines.push(tone(panel, "muted", "  ↓ more")); lines.push("", tone(panel, "muted", "↑/↓/j/k navigate • Enter/M model • E effort • Tab profiles"), tone(panel, "muted", "R reset • S save • A activate • D default"), tone(panel, "muted", "N new • Del remove • Esc/Q close")); return card(lines, width); }
function tabLine(panel: ProfilePanel, width: number) { const all = panel.tabs().join("  │  "); return visibleWidth(all) <= width ? all : panel.tabs()[panel.selectedTab] ?? "+ new"; }
