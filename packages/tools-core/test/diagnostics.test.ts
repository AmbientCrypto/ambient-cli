import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ToolContext } from "@amb/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectCheckers, diagnosticsTool } from "../src/tools/diagnostics.js";

let ws: string;
beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), "amb-diag-")));
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const ctx = (): ToolContext => ({
  cwd: ws,
  workspaceRoot: ws,
  signal: new AbortController().signal,
  secret: async () => "",
  emit: () => {},
});

// The repo's own TypeScript, linked into the throwaway project.
const typescriptDir = dirname(
  createRequire(join(process.cwd(), "package.json")).resolve("typescript/package.json"),
);

describe("diagnostics", () => {
  it("runs the project's TypeScript and returns its errors by file and line", async () => {
    mkdirSync(join(ws, "node_modules"));
    symlinkSync(typescriptDir, join(ws, "node_modules", "typescript"), "junction");
    writeFileSync(
      join(ws, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["src"] }),
    );
    mkdirSync(join(ws, "src"));
    writeFileSync(
      join(ws, "src", "a.ts"),
      "export const n: number = 1;\nexport const s: string = n;\n",
    );
    writeFileSync(join(ws, "src", "b.ts"), "export const ok = 1;\n");
    expect(detectCheckers(ws).map((p) => p.checker)).toEqual(["tsc"]);
    const r = await diagnosticsTool.execute({}, ctx());
    expect(r.checkers).toEqual(["tsc"]);
    expect(r.diagnostics).toEqual([
      expect.objectContaining({
        checker: "tsc",
        file: "src/a.ts",
        line: 2,
        severity: "error",
        code: "TS2322",
      }),
    ]);
    expect((await diagnosticsTool.execute({ path: "src/b.ts" }, ctx())).diagnostics).toEqual([]);
  }, 60_000);

  it("says so when the project has no checker it can run", async () => {
    await expect(diagnosticsTool.execute({}, ctx())).rejects.toThrow(/found no checker/);
    await expect(diagnosticsTool.execute({ checker: "cargo" }, ctx())).rejects.toThrow(
      /doesn't use cargo/,
    );
  });

  it("never reports clean when the checker's output was too big or couldn't be read", async () => {
    mkdirSync(join(ws, "node_modules", "eslint", "bin"), { recursive: true });
    writeFileSync(join(ws, "eslint.config.js"), "export default [];\n");
    // A fake ESLint that prints ~6 MB of results and exits 1 (problems found).
    writeFileSync(
      join(ws, "node_modules", "eslint", "bin", "eslint.js"),
      `const m = Array.from({ length: 3000 }, () => ({ line: 1, column: 1, severity: 2, message: "x".repeat(2000), ruleId: "r" }));
process.stdout.write(JSON.stringify([{ filePath: ${JSON.stringify(join(ws, "a.js"))}, messages: m }]), () => process.exit(1));\n`,
    );
    const big = await diagnosticsTool.execute({ checker: "eslint" }, ctx());
    expect(big.truncated).toBe(true);
    expect(big.notes.join()).toMatch(/more than we read/);

    // Exit 1 with nothing parseable (a crash, a config error) shows what it printed.
    writeFileSync(
      join(ws, "node_modules", "eslint", "bin", "eslint.js"),
      `process.stderr.write("Oops! Something went wrong: bad config"); process.exitCode = 1;\n`,
    );
    const broken = await diagnosticsTool.execute({ checker: "eslint" }, ctx());
    expect(broken.diagnostics).toEqual([]);
    expect(broken.notes.join()).toMatch(/bad config/);
  }, 60_000);

  it("says when a solution-style tsconfig checks none of the projects it references", () => {
    mkdirSync(join(ws, "node_modules"));
    symlinkSync(typescriptDir, join(ws, "node_modules", "typescript"), "junction");
    writeFileSync(
      join(ws, "tsconfig.json"),
      JSON.stringify({ files: [], references: [{ path: "./packages/a" }] }),
    );
    expect(detectCheckers(ws)[0]?.note).toMatch(/only references other projects/);
  });

  it("checking one clean file shows no other file's errors as notes", async () => {
    mkdirSync(join(ws, "node_modules", "typescript", "bin"), { recursive: true });
    writeFileSync(join(ws, "tsconfig.json"), "{}");
    writeFileSync(
      join(ws, "node_modules", "typescript", "bin", "tsc"),
      `process.stdout.write("src/other.ts(1,1): error TS1005: x\\n"); process.exitCode = 1;\n`,
    );
    const r = await diagnosticsTool.execute({ path: "src/a.ts" }, ctx());
    expect(r.diagnostics).toEqual([]);
    expect(r.notes.join()).not.toContain("other.ts");
  });
});
