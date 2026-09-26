import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildRepoMap,
  extractImports,
  extractSymbols,
  pageRank,
  repoMap,
  scanWorkspace,
} from "../src/repo-map.js";
import { estimateTokens } from "../src/tokens.js";

describe("extractSymbols", () => {
  it("pulls top-level TS/JS declarations as signatures (not bodies)", () => {
    const src = [
      "import { z } from 'zod';",
      "export function run(task: string): void {",
      "  const x = 1;", // a body line — must NOT be captured
      "}",
      "export class Agent {}",
      "export interface Opts { a: number }",
      "export type Lane = 'direct' | 'assisted';",
      "const helper = () => 2;",
      "export const CONST_X = 3;",
    ].join("\n");
    const syms = extractSymbols("src/agent.ts", src);
    expect(syms.some((s) => s.includes("function run"))).toBe(true);
    expect(syms.some((s) => s.includes("class Agent"))).toBe(true);
    expect(syms.some((s) => s.includes("interface Opts"))).toBe(true);
    expect(syms.some((s) => s.includes("type Lane"))).toBe(true);
    expect(syms.some((s) => s.includes("const x = 1"))).toBe(false); // body not captured
  });

  it("pulls Python def/class", () => {
    const syms = extractSymbols(
      "x.py",
      "import os\ndef foo(a):\n    return a\nclass Bar:\n    pass",
    );
    expect(syms.some((s) => s.includes("def foo"))).toBe(true);
    expect(syms.some((s) => s.includes("class Bar"))).toBe(true);
  });

  it("returns [] for a language it doesn't parse", () => {
    expect(extractSymbols("data.json", '{"a":1}')).toEqual([]);
  });
});

describe("extractImports", () => {
  it("finds ES import/require/export-from specifiers", () => {
    const src = [
      "import a from './a.js';",
      "import { b } from '../b';",
      "export { c } from './c';",
      "const d = require('./d');",
    ].join("\n");
    expect(extractImports("src/x.ts", src).sort()).toEqual(["../b", "./a.js", "./c", "./d"]);
  });
});

describe("pageRank", () => {
  it("ranks a hub (imported by many) above a leaf", () => {
    const nodes = ["hub", "a", "b", "c"];
    const edges: [string, string][] = [
      ["a", "hub"],
      ["b", "hub"],
      ["c", "hub"],
    ];
    const r = pageRank(nodes, edges);
    expect((r.get("hub") ?? 0) > (r.get("a") ?? 0)).toBe(true);
  });
});

describe("buildRepoMap", () => {
  const files = [
    { path: "src/util.ts", content: "export function shared() {}\nexport const K = 1;" },
    { path: "src/a.ts", content: "import { shared } from './util';\nexport function a() {}" },
    { path: "src/b.ts", content: "import { shared } from './util.js';\nexport function b() {}" },
  ];

  it("renders a ranked, signature-only map with the hub first", () => {
    const map = buildRepoMap(files, { tokenBudget: 1000 });
    expect(map).toContain("src/util.ts");
    expect(map).toContain("function shared");
    // util is imported by both a and b → highest centrality → appears before a and b
    expect(map.indexOf("src/util.ts")).toBeLessThan(map.indexOf("src/a.ts"));
  });

  it("respects the token budget and notes omissions instead of dumping everything", () => {
    const small = buildRepoMap(files, { tokenBudget: 60 }); // room for ~1 file, not all three
    expect(small).toMatch(/more/i); // omission is surfaced (footer or in-block "… (N more)")
    expect(estimateTokens(small)).toBeLessThanOrEqual(60); // and it never exceeds the budget
  });

  it("returns '' when there is nothing to map, or the budget can't fit even one file", () => {
    expect(buildRepoMap([], { tokenBudget: 1000 })).toBe("");
    expect(buildRepoMap([{ path: "d.json", content: "{}" }], { tokenBudget: 1000 })).toBe("");
    expect(buildRepoMap(files, { tokenBudget: 5 })).toBe(""); // smaller than the header → nothing fits
  });
});

describe("scanWorkspace + repoMap (fs)", () => {
  let ws: string;
  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "amb-repomap-"));
  });
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });
  const write = (rel: string, content: string) => {
    const p = join(ws, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  };

  it("scans code files, skipping node_modules/dist/.git", () => {
    write("src/main.ts", "export function main() {}");
    write("node_modules/pkg/index.js", "module.exports = {}");
    write("dist/main.js", "export function main() {}");
    write(".git/config", "[core]");
    const scanned = scanWorkspace(ws).map((f) => f.path);
    expect(scanned).toContain("src/main.ts");
    expect(scanned.some((p) => p.includes("node_modules"))).toBe(false);
    expect(scanned.some((p) => p.startsWith("dist/"))).toBe(false);
    expect(scanned.some((p) => p.includes(".git"))).toBe(false);
  });

  it("repoMap(root) produces a non-empty ranked map for a real tree", () => {
    write("src/core.ts", "export function core() {}");
    write("src/user.ts", "import { core } from './core';\nexport function user() {}");
    const map = repoMap(ws, 2000);
    expect(map).toContain("src/core.ts");
    expect(map).toContain("function core");
  });

  it("a zero wall-clock deadline stops the scan immediately (bounds worst-case first-token)", () => {
    write("src/a.ts", "export function a() {}");
    write("src/b.ts", "export function b() {}");
    // deadlineMs:0 → the walk's very first `done()` check trips → an empty (but SAFE, non-hanging) scan.
    expect(scanWorkspace(ws, { deadlineMs: 0 })).toEqual([]);
    // …while a generous deadline still returns the files (the bound only bites a pathological tree).
    expect(scanWorkspace(ws, { deadlineMs: 5000 }).length).toBeGreaterThan(0);
  });
});
