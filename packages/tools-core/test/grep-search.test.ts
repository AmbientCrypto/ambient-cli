import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@amb/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findRipgrep, ripgrepSearch } from "../src/ripgrep.js";
import { grepTool } from "../src/tools/grep.js";

let ws: string;
beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), "amb-grep-")));
  mkdirSync(join(ws, "src", "ui"), { recursive: true });
  writeFileSync(join(ws, "src", "a.ts"), "const token = 1;\nconst other = 2;\n");
  writeFileSync(join(ws, "src", "ui", "b.tsx"), "export const tokenView = () => null;\n");
  writeFileSync(join(ws, "notes.md"), "token notes\n");
  mkdirSync(join(ws, "secret"));
  writeFileSync(join(ws, "secret", "k.ts"), "const token = 'SECRET';\n");
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const ctx = (denied?: (p: string) => boolean): ToolContext => ({
  cwd: ws,
  workspaceRoot: ws,
  signal: new AbortController().signal,
  secret: async () => "",
  emit: () => {},
  ...(denied ? { readDenied: denied } : {}),
});
const files = (r: { matches: { file: string }[] }) =>
  [...new Set(r.matches.map((m) => m.file))].sort();

const hasRg = findRipgrep(join(tmpdir(), "no-such-workspace")) !== undefined;

describe("grep", () => {
  it("filters by a real glob or a name ending, and skips files your rules deny", async () => {
    // Compared by the folder name: on Windows the temp folder has a short and a long spelling.
    const denied = (p: string) => /[\\/]secret[\\/]/.test(p);
    expect(
      files(
        await grepTool.execute(
          { pattern: "token", path: ".", glob: "src/**/*.tsx", limit: 50 },
          ctx(),
        ),
      ),
    ).toEqual(["src/ui/b.tsx"]);
    expect(
      files(
        await grepTool.execute(
          { pattern: "token", path: ".", glob: ".ts", limit: 50 },
          ctx(denied),
        ),
      ),
    ).toEqual(["src/a.ts"]);
    expect(
      files(
        await grepTool.execute(
          { pattern: "token", path: ".", glob: "*.ts", limit: 50 },
          ctx(denied),
        ),
      ),
    ).toEqual(["src/a.ts"]);
  });

  it("a JavaScript-only regex still works (ripgrep can't do lookbehind; the JS search can)", async () => {
    const r = await grepTool.execute({ pattern: "(?<=const )other", path: ".", limit: 50 }, ctx());
    expect(r.matches.map((m) => `${m.file}:${m.line}`)).toEqual(["src/a.ts:2"]);
  });

  it("stops at the limit and says so", async () => {
    const r = await grepTool.execute({ pattern: "token", path: ".", limit: 1 }, ctx());
    expect(r.matches).toHaveLength(1);
    expect(r.truncated).toBe(true);
  });
});

describe.skipIf(process.platform === "win32")("finding ripgrep", () => {
  it("never uses an rg shipped inside the workspace", () => {
    const planted = join(ws, "bin");
    mkdirSync(planted);
    writeFileSync(join(planted, "rg"), "#!/bin/sh\necho PWNED\n");
    chmodSync(join(planted, "rg"), 0o755);
    expect(findRipgrep(ws, { PATH: planted })).toBeUndefined();
    expect(findRipgrep(join(tmpdir(), "elsewhere"), { PATH: planted })).toBe(join(planted, "rg"));
  });

  it.skipIf(!hasRg)(
    "really runs ripgrep, and hands a regex it can't do back to the JS search",
    async () => {
      const rg = findRipgrep(join(tmpdir(), "elsewhere")) as string;
      const base = {
        rg,
        root: ws,
        start: "src",
        limit: 50,
        maxLineChars: 5000,
        signal: new AbortController().signal,
      };
      const found = await ripgrepSearch({ ...base, pattern: "tokenView" });
      expect(found?.matches.map((m) => m.file)).toEqual(["src/ui/b.tsx"]);
      expect(await ripgrepSearch({ ...base, pattern: "(?<=const )other" })).toBeUndefined();
    },
  );

  it.skipIf(!hasRg)("never returns lines from secret files, like the JS search", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(ws, "src", ".env"), "API_KEY=tokenSECRET\n");
    await writeFile(join(ws, "src", "server.pem"), "tokenPEM\n");
    const found = await grepTool.execute(
      { pattern: "token(SECRET|PEM)", path: "src", limit: 50 },
      ctx(),
    );
    expect(found.matches).toEqual([]);
  });

  it.skipIf(!hasRg)("gives the same answers as the JS search", async () => {
    const withRg = await grepTool.execute({ pattern: "token\\w*", path: "src", limit: 50 }, ctx());
    const saved = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      const withJs = await grepTool.execute(
        { pattern: "token\\w*", path: "src", limit: 50 },
        ctx(),
      );
      expect(withRg.matches.sort((a, b) => a.file.localeCompare(b.file))).toEqual(
        withJs.matches.sort((a, b) => a.file.localeCompare(b.file)),
      );
    } finally {
      process.env.PATH = saved;
    }
  });
});
