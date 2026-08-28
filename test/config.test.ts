import { describe, expect, it } from "vitest";
import { mergeConfigs, resolveRoute, validateConfig } from "../src/config.js";
import { DEFAULT_SHORTCUT } from "../src/constants.js";

describe("profile configuration", () => {
  it("normalizes agent keys and validates references and known efforts", () => {
    expect(
      validateConfig({
        version: 1,
        defaultProfile: "P",
        profiles: {
          P: { order: 1, agents: { Researcher: { effort: "high" } } },
        },
      }).config?.profiles.P.agents,
    ).toEqual({ researcher: { effort: "high" } });
    expect(
      validateConfig({
        version: 1,
        defaultProfile: "missing",
        profiles: { p: { order: 1 } },
      }).error,
    ).toMatch(/defaultProfile/);
    expect(
      validateConfig({
        version: 1,
        profiles: { p: { order: 1, defaultRoute: { effort: "invented" } } },
      }).error,
    ).toMatch(/effort/);
  });

  it("defaults missing shortcuts to alt+p and migrates only the old generated default", () => {
    expect(validateConfig({ version: 1, profiles: {} }).config?.shortcut).toBe(
      "alt+p",
    );
    expect(DEFAULT_SHORTCUT).toBe("alt+p");
    expect(
      validateConfig({ version: 1, shortcut: "ctrl+tab", profiles: {} }).config
        ?.shortcut,
    ).toBe("alt+p");
    expect(
      validateConfig({ version: 1, shortcut: "ctrl+alt+p", profiles: {} })
        .config?.shortcut,
    ).toBe("ctrl+alt+p");
  });

  it("lets trusted project profiles replace same-name global profiles as whole", () => {
    expect(
      mergeConfigs(
        {
          version: 1,
          profiles: { p: { order: 1, defaultRoute: { effort: "low" } } },
        },
        {
          version: 1,
          profiles: { p: { order: 2, defaultRoute: { effort: "high" } } },
        },
      ).profiles.p,
    ).toEqual({ order: 2, defaultRoute: { effort: "high" } });
  });

  it("preserves explicit model and effort suppression while emitting only Joker-valid fields", () => {
    const profile = validateConfig({
      version: 1,
      profiles: {
        p: {
          order: 1,
          defaultRoute: { model: null, effort: "inherit" },
          agents: { Researcher: { effort: "high" } },
        },
      },
    }).config!.profiles.p;

    expect(profile.defaultRoute).toEqual({ model: null, effort: "inherit" });
    expect(resolveRoute(profile, "researcher")).toEqual({ effort: "high" });
    expect(resolveRoute(profile, "other")).toEqual({});
  });
});
