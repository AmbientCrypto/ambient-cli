import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMemoryPort, quickNote } from "../src/agent/memory-port.js";
import { makeWorkspaceContextPort } from "../src/agent/workspace-context-port.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "amb-mem-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("quick notes", () => {
  it("is one line starting with a single #", () => {
    expect(quickNote("# use pnpm, not npm")).toBe("use pnpm, not npm");
    expect(quickNote("#no space works too")).toBe("no space works too");
    expect(quickNote("## A heading")).toBeUndefined();
    expect(quickNote("# Title\nthe rest of a pasted doc")).toBeUndefined();
    expect(quickNote("#")).toBeUndefined();
    expect(quickNote("fix #42")).toBeUndefined();
  });
});

describe("the memory port", () => {
  it("keeps project and every-project notes apart, lists them, and forgets by number", () => {
    const ws = join(dir, "ws");
    const home = join(dir, "home");
    const m = makeMemoryPort(ws, home);
    expect(m.remember("tests run with vitest")).toContain("Noted for this project");
    m.remember("the API lives in packages/api");
    expect(m.rememberEverywhere("I prefer small commits")).toBe(
      "Noted for every project: I prefer small commits",
    );
    const report = m.report();
    expect(report).toContain("  1. tests run with vitest");
    expect(report).toContain("  2. the API lives in packages/api");
    expect(report).toContain("  u1. I prefer small commits");

    expect(m.forget("1")).toBe("Forgot: tests run with vitest");
    expect(m.forget("u1")).toBe("Forgot: I prefer small commits");
    expect(m.forget("9")).toBe("There's no note 9.");
    expect(m.forget("x")).toContain("usage");
    expect(m.report()).toContain("  1. the API lives in packages/api");
    expect(readFileSync(join(ws, ".ambient", "MEMORY.md"), "utf8")).not.toContain("vitest");
  });

  it("every-project notes reach the prompt through the workspace port", () => {
    const prev = process.env.AMB_HOME;
    process.env.AMB_HOME = join(dir, "home");
    try {
      makeMemoryPort(join(dir, "ws"), join(dir, "home")).rememberEverywhere(
        "answer in British English",
      );
      expect(makeWorkspaceContextPort().readUserMemory?.()).toBe("- answer in British English");
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, "AMB_HOME");
      else process.env.AMB_HOME = prev;
    }
  });
});
