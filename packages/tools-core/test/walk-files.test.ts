import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { walkFiles } from "../src/walk-files.js";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "amb-walk-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});
const write = (rel: string, content = "x") => {
  const p = join(ws, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
};
async function collect(): Promise<string[]> {
  const out: string[] = [];
  for await (const f of walkFiles(ws)) out.push(f);
  return out.sort();
}

describe("walkFiles — .gitignore + secret skipping", () => {
  it("skips secret files so grep/glob can't enumerate them into context", async () => {
    write("src/app.ts");
    write(".env");
    write(".env.production");
    write("keys/server.pem");
    write("keys/id_rsa");
    const files = await collect();
    expect(files).toContain("src/app.ts");
    expect(files.some((f) => f.includes(".env"))).toBe(false);
    expect(files.some((f) => f.endsWith(".pem"))).toBe(false);
    expect(files.some((f) => f.endsWith("id_rsa"))).toBe(false);
  });

  it("honors the root .gitignore (plain names + *.ext)", async () => {
    write(".gitignore", "secrets\n*.log\nbuildcache/\n");
    write("src/main.ts");
    write("secrets/token.txt");
    write("debug.log");
    write("buildcache/out.js");
    const files = await collect();
    expect(files).toContain("src/main.ts");
    expect(files.some((f) => f.startsWith("secrets/"))).toBe(false); // gitignored dir
    expect(files.some((f) => f.endsWith(".log"))).toBe(false); // gitignored *.log
    expect(files.some((f) => f.startsWith("buildcache/"))).toBe(false); // gitignored `buildcache/`
  });

  it("still skips the built-in build/deps dirs and yields normal code", async () => {
    write("src/a.ts");
    write("node_modules/pkg/index.js");
    write("dist/a.js");
    write("target/debug/x.rs");
    const files = await collect();
    expect(files).toEqual(["src/a.ts"]);
  });

  it("SKIPS an unreadable directory (EACCES) and keeps walking — one denied dir never fails the whole walk", async () => {
    // root bypasses permission bits, so chmod 000 wouldn't produce EACCES there — skip in that (CI) case.
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    if (process.platform === "win32") return; // Windows ignores POSIX permission bits
    write("src/a.ts");
    write("locked/secret.ts");
    write("src/b.ts");
    const locked = join(ws, "locked");
    chmodSync(locked, 0o000); // the owner can no longer readdir it → EACCES, like a locked directory hit during a walk
    try {
      const files = await collect(); // must NOT throw
      expect(files).toContain("src/a.ts");
      expect(files).toContain("src/b.ts"); // the walk continued past the denied dir
      expect(files.some((f) => f.startsWith("locked/"))).toBe(false); // the unreadable dir was skipped
    } finally {
      chmodSync(locked, 0o755); // restore so afterEach can clean up
    }
  });
});
