import { CONFIG_VERSION, DEFAULT_SHORTCUT } from "./constants.js";
import type {
  Config,
  ModelRef,
  PersistedRoute,
  Profile,
  Route,
  ThinkingLevel,
} from "./types.js";

const EFFORTS = new Set<ThinkingLevel>([
  "inherit",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const has = (value: Record<string, unknown>, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);

/** Migration for the old generated default emitted by earlier versions. */
const LEGACY_DEFAULT_SHORTCUT = "ctrl+tab";

export const normalizeAgent = (name: string) => name.trim().toLowerCase();

function route(value: unknown): PersistedRoute | undefined {
  if (!object(value)) return undefined;

  const result: PersistedRoute = {};
  if (has(value, "model")) {
    if (value.model === null) {
      result.model = null;
    } else if (
      object(value.model) &&
      typeof value.model.provider === "string" &&
      value.model.provider.trim() &&
      typeof value.model.id === "string" &&
      value.model.id.trim()
    ) {
      result.model = {
        provider: value.model.provider.trim(),
        id: value.model.id.trim(),
      } satisfies ModelRef;
    } else {
      return undefined;
    }
  }

  if (value.effort !== undefined) {
    if (
      typeof value.effort !== "string" ||
      !EFFORTS.has(value.effort as ThinkingLevel)
    ) {
      return undefined;
    }
    result.effort = value.effort as ThinkingLevel;
  }

  return Object.keys(result).length ? result : undefined;
}

export function validateConfig(raw: unknown): {
  config?: Config;
  error?: string;
} {
  if (!object(raw) || raw.version !== CONFIG_VERSION || !object(raw.profiles)) {
    return { error: "expected version 1 and profiles object" };
  }

  const profiles: Record<string, Profile> = {};
  for (const [name, rawProfile] of Object.entries(raw.profiles)) {
    if (
      !name.trim() ||
      !object(rawProfile) ||
      !Number.isInteger(rawProfile.order)
    ) {
      return { error: `invalid profile ${name}` };
    }

    const agents: Record<string, PersistedRoute> = {};
    if (rawProfile.agents !== undefined) {
      if (!object(rawProfile.agents)) {
        return { error: `invalid agents in ${name}` };
      }
      for (const [agent, rawRoute] of Object.entries(rawProfile.agents)) {
        const parsed = route(rawRoute);
        const normalized = normalizeAgent(agent);
        if (!normalized || !parsed || agents[normalized]) {
          return { error: `invalid agent override ${agent}` };
        }
        agents[normalized] = parsed;
      }
    }

    const orchestrator =
      rawProfile.orchestrator === undefined
        ? undefined
        : route(rawProfile.orchestrator);
    const defaultRoute =
      rawProfile.defaultRoute === undefined
        ? undefined
        : route(rawProfile.defaultRoute);
    if (
      (rawProfile.orchestrator !== undefined && !orchestrator) ||
      (rawProfile.defaultRoute !== undefined && !defaultRoute)
    ) {
      return { error: `invalid route or effort in ${name}` };
    }

    profiles[name] = {
      order: rawProfile.order as number,
      ...(orchestrator ? { orchestrator } : {}),
      ...(defaultRoute ? { defaultRoute } : {}),
      agents,
    };
  }

  const defaultProfile =
    raw.defaultProfile === undefined
      ? undefined
      : typeof raw.defaultProfile === "string" && raw.defaultProfile in profiles
        ? raw.defaultProfile
        : undefined;
  if (raw.defaultProfile !== undefined && !defaultProfile) {
    return { error: "invalid defaultProfile reference" };
  }

  let cycle: string[] | undefined;
  if (raw.cycle !== undefined) {
    if (
      !Array.isArray(raw.cycle) ||
      !raw.cycle.every(
        (name) => typeof name === "string" && name in profiles,
      ) ||
      new Set(raw.cycle).size !== raw.cycle.length
    ) {
      return { error: "invalid cycle reference" };
    }
    cycle = raw.cycle;
  }

  if (
    raw.shortcut !== undefined &&
    (typeof raw.shortcut !== "string" || !raw.shortcut.trim())
  ) {
    return { error: "invalid shortcut" };
  }

  return {
    config: {
      version: CONFIG_VERSION,
      ...(defaultProfile ? { defaultProfile } : {}),
      ...(cycle ? { cycle } : {}),
      shortcut:
        raw.shortcut === LEGACY_DEFAULT_SHORTCUT
          ? DEFAULT_SHORTCUT
          : ((raw.shortcut as string | undefined) ?? DEFAULT_SHORTCUT),
      profiles,
    },
  };
}

export function emptyConfig(): Config {
  return { version: CONFIG_VERSION, shortcut: DEFAULT_SHORTCUT, profiles: {} };
}

export function mergeConfigs(global: Config, project?: Config): Config {
  if (!project) return global;
  return {
    ...global,
    ...project,
    shortcut: global.shortcut,
    profiles: { ...global.profiles, ...project.profiles },
  };
}

/** Removes config-only suppression sentinels before a route enters an event or snapshot. */
export function resolveDefaultRoute(route: PersistedRoute | undefined): Route {
  const result: Route = {};
  if (route?.model) result.model = route.model;
  if (route?.effort && route.effort !== "inherit") result.effort = route.effort;
  return result;
}

/** Resolves persisted defaults and overrides to an event-safe route. */
export function resolveRoute(profile: Profile, agent: string): Route {
  const fallback = profile.defaultRoute;
  const override = profile.agents?.[normalizeAgent(agent)];
  const result = resolveDefaultRoute(fallback);

  if (override && has(override, "model")) {
    if (override.model) result.model = override.model;
    else delete result.model;
  }
  if (override && has(override, "effort")) {
    if (override.effort && override.effort !== "inherit") {
      result.effort = override.effort;
    } else {
      delete result.effort;
    }
  }

  return result;
}
