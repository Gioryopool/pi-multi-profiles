import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };

const shippedText = [
  "README.md",
  "index.ts",
  "src/catalog.ts",
  "src/commands.ts",
  "src/config.ts",
  "src/constants.ts",
  "src/extension.ts",
  "src/profile-manager.ts",
  "src/profile-panel.ts",
  "src/session-state.ts",
  "src/storage.ts",
  "src/types.ts",
  "src/subagents-runtime/discovery.ts",
  "src/subagents-runtime/ownership.ts",
  "src/subagents-runtime/types.ts",
]
  .map((path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8"))
  .join("\n");

it("declares the Pi extension package contract", () => {
  expect(pkg).toMatchObject({
    name: "pi-multi-profiles",
    version: "0.1.6",
    license: "MIT",
    main: "./index.ts",
    publishConfig: { access: "public" },
    pi: { extensions: ["./index.ts"] },
  });
  expect("private" in pkg).toBe(false);
  expect(pkg.files).toEqual(["index.ts", "src", "docs", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"]);
  expect(pkg.peerDependencies?.["@earendil-works/pi-coding-agent"]).toBe("*");
  expect(pkg.peerDependencies?.["@earendil-works/pi-tui"]).toBe("*");
  expect(pkg.devDependencies?.["@earendil-works/pi-tui"]).toBe("0.84.2");
  expect(pkg.peerDependenciesMeta?.["@earendil-works/pi-coding-agent"]?.optional).toBe(true);
  expect(pkg.devDependencies?.["@earendil-works/pi-coding-agent"]).toBe("0.84.2");
});

it("ships complete adapted-source attribution", () => {
const notices = readFileSync(new URL("../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8");
expect(notices).toContain("pi-subagents-j0k3r");
expect(notices).toContain("Copyright (c) 2026 j0k3r");
expect(notices).toContain("Permission is hereby granted");
});

it("keeps retired Gentle integration paths out of shipped source and docs", () => {
  expect(shippedText).not.toContain("/gentle:");
  expect(shippedText).not.toContain(".pi/gentle-ai");
});
