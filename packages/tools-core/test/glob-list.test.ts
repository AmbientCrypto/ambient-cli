import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@amb/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { globTool, patternStart } from "../src/tools/glob.js";
import { listTool } from "../src/tools/list.js";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "amb-glob-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});
const write = (rel: string, content = "x") => {
  const p = join(ws, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
};
const ctx = (): ToolContext =>
  ({ workspaceRoot: ws, cwd: ws, signal: new AbortController().signal }) as unknown as ToolContext;

describe("patternStart — the literal prefix to start the walk at", () => {
  it("returns the dir before the first wildcard", () => {
    expect(patternStart("src/tui/**/*.ts")).toBe("src/tui");
    expect(patternStart("**/*.ts")).toBe("");
    expect(patternStart("packages/cli/src/*.json")).toBe("packages/cli/src");
    expect(patternStart("node_modules/ink/build/**/*.js")).toBe("node_modules/ink/build");
    expect(patternStart("README.md")).toBe(""); // a bare filename is not a dir to descend into
  });
});

describe("glob — scoping + robustness", () => {
  it("matches workspace-relative files and ignores a misleading leading slash", async () => {
    write("src/a.ts");
    write("src/b.ts");
    write("docs/c.md");
    const r1 = await globTool.execute({ pattern: "src/**/*.ts", limit: 200 }, ctx());
    expect(r1.matches.sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(r1.timedOut).toBe(false);
    // A leading "/" is treated as workspace-relative, not filesystem root — still matches.
    const r2 = await globTool.execute({ pattern: "/src/**/*.ts", limit: 200 }, ctx());
    expect(r2.matches.sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("CAN glob into an otherwise-ignored dir when the pattern names it (node_modules)", async () => {
    write("node_modules/ink/build/index.js");
    write("node_modules/ink/build/components/Box.js");
    write("src/app.ts");
    const r = await globTool.execute(
      { pattern: "node_modules/ink/build/**/*.js", limit: 200 },
      ctx(),
    );
    expect(r.matches.sort()).toEqual([
      "node_modules/ink/build/components/Box.js",
      "node_modules/ink/build/index.js",
    ]);
  });

  it("a normal walk still skips node_modules (not explicitly targeted)", async () => {
    write("node_modules/pkg/index.js");
    write("src/app.js");
    const r = await globTool.execute({ pattern: "**/*.js", limit: 200 }, ctx());
    expect(r.matches).toEqual(["src/app.js"]); // node_modules pruned
  });
});

describe("list — soft not-found", () => {
  it("returns a soft notFound result for a missing dir (no throw, not an error)", async () => {
    const r = await listTool.execute({ path: ".github/workflows" }, ctx());
    expect(r.notFound).toBe(true);
    expect(r.entries).toEqual([]);
  });

  it("lists a real dir normally", async () => {
    write("src/a.ts");
    write("src/b.ts");
    const r = await listTool.execute({ path: "src" }, ctx());
    expect(r.notFound).toBe(false);
    expect(r.entries.map((e) => e.name).sort()).toEqual(["a.ts", "b.ts"]);
  });
});
