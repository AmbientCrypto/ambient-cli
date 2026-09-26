import { describe, expect, it } from "vitest";
import { DYNAMIC_BOUNDARY, buildSystemPrompt } from "../src/system-prompt.js";

describe("buildSystemPrompt", () => {
  it("keeps the static preamble before the dynamic boundary (prompt-cacheable)", () => {
    const p = buildSystemPrompt({ cwd: "/w", model: "vendor/m" });
    const [staticHalf, dynamicHalf] = p.split(DYNAMIC_BOUNDARY);
    expect(staticHalf).toContain("You are amb");
    expect(dynamicHalf).toContain("Working directory: /w");
    expect(dynamicHalf).toContain("Active model: vendor/m");
  });

  it("injects the git snapshot when present, omits it entirely when absent", () => {
    const withGit = buildSystemPrompt({
      cwd: "/w",
      model: "vendor/m",
      git: "Branch: main\nWorking tree: clean",
    });
    expect(withGit).toContain("Git (at run start");
    expect(withGit).toContain("Branch: main");

    const noGit = buildSystemPrompt({ cwd: "/w", model: "vendor/m" });
    expect(noGit).not.toContain("Git (at run start");
  });

  it("selects the PLAN preamble in plan mode (read-only, present a plan) and the BUILD one otherwise", () => {
    const plan = buildSystemPrompt({ cwd: "/w", model: "vendor/m", mode: "plan" });
    expect(plan).toContain("PLAN MODE");
    expect(plan).toContain("READ-ONLY");
    expect(plan).toContain("`plan` tool"); // it records a plan and stops
    expect(plan).not.toContain("run shell commands"); // no execution instruction to loop on
    expect(plan).not.toContain("Verify your work by running"); // …and no build/test directive

    const build = buildSystemPrompt({ cwd: "/w", model: "vendor/m", mode: "bypass" });
    expect(build).toContain("run shell commands"); // build keeps the execution preamble
    expect(build).not.toContain("PLAN MODE");
    // default (no mode) is the build preamble
    expect(buildSystemPrompt({ cwd: "/w", model: "vendor/m" })).not.toContain("PLAN MODE");
  });

  it("pins the north-star goal FIRST in the dynamic block, with the self-check directive", () => {
    const p = buildSystemPrompt({ cwd: "/w", model: "vendor/m", goal: "ship the CSV export" });
    const dynamic = p.split(DYNAMIC_BOUNDARY)[1] ?? "";
    expect(dynamic).toContain("NORTH-STAR GOAL");
    expect(dynamic).toContain("ship the CSV export");
    expect(dynamic).toContain("only the user changes it");
    // primacy: the goal appears before the working-directory line
    expect(dynamic.indexOf("NORTH-STAR GOAL")).toBeLessThan(dynamic.indexOf("Working directory"));
    // absent when no goal
    expect(buildSystemPrompt({ cwd: "/w", model: "vendor/m" })).not.toContain("NORTH-STAR GOAL");
  });
});
