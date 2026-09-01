import { requestCatalog } from "./catalog.js";
import { ProfilePanel, type PanelAction, type PanelSessionState } from "./profile-panel.js";
import type { ProfileManager } from "./profile-manager.js";
import type { CatalogAgent, ExtensionCommandContext, PiLike, Profile } from "./types.js";

type Scope = "global" | "project";
type Save = (ctx: ExtensionCommandContext, name: string, profile: Profile | undefined, scope: Scope, defaultProfile?: string) => Promise<void>;
type ScopeMap = (ctx: ExtensionCommandContext) => Record<string, Scope>;

export function parseCommand(input: string) {
  const [verb = "", ...rest] = input.trim().split(/\s+/);
  return { verb: verb.toLowerCase(), name: rest.join(" ") };
}

export function formatAgentRouteLabel(agent: string, profile: Profile): string {
  const name = agent.trim().toLowerCase();
  const route = profile.agents?.[name] ?? profile.defaultRoute;
  const model = route?.model && typeof route.model === "object" ? `${route.model.provider}/${route.model.id}` : "inherit";
  const effort = route?.effort && route.effort !== "inherit" ? route.effort : "inherit";
  return `${name} · model: ${model} · effort: ${effort}`;
}

const copy = <T>(value: T): T => structuredClone(value);
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const initial = (manager: ProfileManager, scoped: Record<string, Scope>): PanelSessionState => ({
  drafts: copy(manager.config.profiles),
  names: Object.entries(manager.config.profiles)
    .sort((a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0]))
    .map(([name]) => name),
  scopes: { ...scoped },
  dirty: [],
  persisted: Object.keys(manager.config.profiles),
  defaultName: manager.config.defaultProfile,
  selectedTab: 0,
  cursor: 0,
  scroll: 0,
});

export function registerCommands(
  pi: PiLike,
  manager: ProfileManager,
  save: Save,
  ensure?: (ctx: ExtensionCommandContext) => Promise<void>,
  scopes: ScopeMap = () => ({}),
  internalCatalog?: (ctx: ExtensionCommandContext) => CatalogAgent[] | undefined,
) {
  pi.registerCommand("agent-profiles", {
    description: "Manage session agent routing profiles",
    getArgumentCompletions: (prefix) => manager.names()
      .filter((name) => name.startsWith(prefix))
      .map((value) => ({ value, label: value })),
    async handler(args, ctx) {
      manager.setContext(ctx);
      const { verb, name } = parseCommand(args);
      try {
        if (ensure) await ensure(ctx);
        if (["list", "status", "use", "next", "off"].includes(verb)) {
          if (verb === "list") return void ctx.ui.notify(manager.names().join("\n") || "No profiles");
          if (verb === "status") return void ctx.ui.notify(manager.state.get(ctx.sessionManager.getSessionId())?.profile ?? "off");
          if (verb === "use") return void await manager.use(name);
          if (verb === "next") return void await manager.next();
          return void await manager.off();
        }
        if (verb && !["create", "edit", "delete"].includes(verb)) {
          throw new Error("Usage: /agent-profiles [list|status|use <name>|next|create|edit <name>|delete <name>|off]");
        }
        if (verb === "edit" && (!name || !manager.config.profiles[name])) throw new Error(`Unknown profile: ${name}`);
        if (verb === "delete") return await deleteFromCommand(ctx, manager, save, scopes(ctx), name);

        let state = initial(manager, scopes(ctx));
        let focusName = verb === "edit" ? name : undefined;
        if (focusName) state.selectedTab = state.names.indexOf(focusName);
        if (verb === "create") state.selectedTab = state.names.length;
        let startInCreate = verb === "create";
        while (true) {
          const result = await openPanel(pi, ctx, manager, state, focusName, startInCreate, internalCatalog);
          startInCreate = false;
          if (!result) {
            if (state.dirty.length && !(await ctx.ui.confirm("Discard unsaved profile changes?", ""))) continue;
            return;
          }
          state = result.session ?? state;
          focusName = undefined;
          if (result.type === "save" && result.name && result.profile) {
            try {
              await save(ctx, result.name, result.profile, state.scopes[result.name] ?? "global");
              markSaved(state, result.name);
            } catch (error) { ctx.ui.notify(errorMessage(error), "error"); }
            continue;
          }
          if (result.type === "activate" && result.name && result.profile) {
            try {
              if (state.dirty.includes(result.name) || !state.persisted.includes(result.name)) {
                await save(ctx, result.name, result.profile, state.scopes[result.name] ?? "global");
                markSaved(state, result.name);
              }
              await manager.use(result.name);
            } catch (error) { ctx.ui.notify(errorMessage(error), "error"); }
            continue;
          }
          if (result.type === "default" && result.name && result.profile) {
            try {
              await save(ctx, result.name, result.profile, state.scopes[result.name] ?? "global", result.name);
              markSaved(state, result.name);
              state.defaultName = manager.config.defaultProfile;
            } catch (error) { ctx.ui.notify(errorMessage(error), "error"); }
            continue;
          }
          if (result.type === "delete" && result.name) {
            if (result.persisted && !(await ctx.ui.confirm("Delete profile", result.name))) continue;
            try {
              if (result.persisted) {
                if (manager.state.get(ctx.sessionManager.getSessionId())?.profile === result.name) await manager.off();
                await save(ctx, result.name, undefined, state.scopes[result.name] ?? "global");
              }
              removeDraft(state, result.name);
              state.defaultName = manager.config.defaultProfile;
            } catch (error) { ctx.ui.notify(errorMessage(error), "error"); }
            continue;
          }
          if (result.type === "close" && state.dirty.length && !(await ctx.ui.confirm("Discard unsaved profile changes?", ""))) continue;
          return;
        }
      } catch (error: unknown) {
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });
}

async function openPanel(pi: PiLike, ctx: ExtensionCommandContext, manager: ProfileManager, state: PanelSessionState, focusName?: string, startInCreate = false, internalCatalog?: (ctx: ExtensionCommandContext) => CatalogAgent[] | undefined) {
  let catalog: CatalogAgent[] | undefined;
  try {
    catalog = internalCatalog?.(ctx);
  } catch {
    ctx.ui.notify("Internal agent catalog is unavailable; using the optional catalog fallback", "warning");
  }
  catalog ??= requestCatalog(pi, ctx.cwd, (message) => ctx.ui.notify(message, "error"));
  return ctx.ui.custom<PanelAction>((tui, theme, _keys, done) => new ProfilePanel({
    profiles: state.drafts,
    agents: catalog,
    scopes: state.scopes,
    activeName: manager.state.get(ctx.sessionManager.getSessionId())?.profile,
    defaultName: state.defaultName,
    models: ctx.modelRegistry.getAvailable().map((model: any) => ({ provider: model.provider, id: model.id, name: model.name })),
    focusName,
    session: state,
    startInCreate,
    theme,
    projectTrusted: ctx.isProjectTrusted(),
    requestRender: () => tui.requestRender(),
    onAction: done,
  }), { overlay: true, overlayOptions: { anchor: "center", width: "70%", minWidth: 72, maxHeight: "85%" } });
}

async function deleteFromCommand(ctx: ExtensionCommandContext, manager: ProfileManager, save: Save, scopeMap: Record<string, Scope>, name: string) {
  if (!name || !manager.config.profiles[name]) throw new Error(`Unknown profile: ${name}`);
  if (!await ctx.ui.confirm("Delete profile", name)) return;
  if (manager.state.get(ctx.sessionManager.getSessionId())?.profile === name) await manager.off();
  await save(ctx, name, undefined, scopeMap[name] ?? "global");
}

function markSaved(state: PanelSessionState, name: string) {
  state.dirty = state.dirty.filter((profileName) => profileName !== name);
  if (!state.persisted.includes(name)) state.persisted.push(name);
}

function removeDraft(state: PanelSessionState, name: string) {
  delete state.drafts[name];
  delete state.scopes[name];
  state.names = state.names.filter((profileName) => profileName !== name);
  state.dirty = state.dirty.filter((profileName) => profileName !== name);
  state.persisted = state.persisted.filter((profileName) => profileName !== name);
  if (state.defaultName === name) state.defaultName = undefined;
  state.selectedTab = Math.min(state.selectedTab, state.names.length);
}
