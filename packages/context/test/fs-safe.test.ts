import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readTextCappedSafe } from "../src/fs-safe.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "amb-fssafe-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("readTextCappedSafe", () => {
  it("reads a normal regular file's full bytes (incl. multibyte UTF-8)", () => {
    const p = join(dir, "f.txt");
    const content = "hello — café 🌍\nsecond line";
    writeFileSync(p, content);
    expect(readTextCappedSafe(p)).toBe(content);
  });

  it("returns null for a missing file, a directory, and an over-cap file", () => {
    expect(readTextCappedSafe(join(dir, "nope.txt"))).toBeNull();
    expect(readTextCappedSafe(dir)).toBeNull(); // a directory
    const big = join(dir, "big.txt");
    writeFileSync(big, "z".repeat(2048));
    expect(readTextCappedSafe(big, { maxBytes: 1024 })).toBeNull();
  });

  it("never follows a symlinked LEAF", () => {
    const secret = join(dir, "secret");
    writeFileSync(secret, "SECRET");
    const link = join(dir, "link.txt");
    symlinkSync(secret, link);
    expect(readTextCappedSafe(link)).toBeNull();
  });

  it("rejects a file reached via a symlinked ANCESTOR that escapes the root", () => {
    const outside = join(dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "f.txt"), "leaked");
    const rootDir = join(dir, "root");
    mkdirSync(rootDir);
    symlinkSync(outside, join(rootDir, "sub")); // root/sub -> outside
    const target = join(rootDir, "sub", "f.txt");
    // With no root: leaf isn't a symlink (f.txt is real inside outside), so it reads.
    expect(readTextCappedSafe(target)).toBe("leaked");
    // With containment root: the real parent (outside) is not under root ⇒ rejected.
    expect(readTextCappedSafe(target, { root: rootDir })).toBeNull();
  });

  it("allows a real file under a root that ends in the separator (e.g. filesystem root)", () => {
    const p = join(dir, "f.txt");
    writeFileSync(p, "ok");
    // The filesystem root ("/" or a drive like "C:\\") ends in the separator — root + sep must not double it.
    expect(readTextCappedSafe(p, { root: parse(p).root })).toBe("ok");
  });
});

describe("memory writes never follow a link out of the project", () => {
  it.skipIf(process.platform === "win32")(
    "a committed .ambient/MEMORY.md symlink is not written through (summary, note or forget)",
    async () => {
      const { readFileSync } = await import("node:fs");
      const { forgetNote, rememberNote, writeMemory } = await import("../src/memory.js");
      const ws = join(dir, "ws");
      mkdirSync(join(ws, ".ambient"), { recursive: true });
      const outside = join(dir, "outside.txt");
      writeFileSync(
        outside,
        "ORIGINAL\n## Notes (curated by the agent — durable across sessions)\n- x\n",
      );
      symlinkSync(outside, join(ws, ".ambient", "MEMORY.md"));
      writeMemory(ws, "a summary");
      expect(rememberNote(ws, "a note")).toBe(false);
      expect(forgetNote(join(ws, ".ambient", "MEMORY.md"), 1, ws)).toBeUndefined();
      expect(readFileSync(outside, "utf8")).toContain("ORIGINAL");
      expect(readFileSync(outside, "utf8")).not.toContain("a summary");
    },
  );
  it.skipIf(process.platform === "win32")(
    "a symlinked .ambient folder pointing outside is refused too",
    async () => {
      const { existsSync } = await import("node:fs");
      const { rememberNote } = await import("../src/memory.js");
      const ws = join(dir, "ws2");
      const elsewhere = join(dir, "elsewhere");
      mkdirSync(ws, { recursive: true });
      mkdirSync(elsewhere, { recursive: true });
      symlinkSync(elsewhere, join(ws, ".ambient"));
      expect(rememberNote(ws, "a note")).toBe(false);
      expect(existsSync(join(elsewhere, "MEMORY.md"))).toBe(false);
    },
  );
  it("still writes and reads normal memory", async () => {
    const { listNotes, readMemory, rememberNote, writeMemory } = await import("../src/memory.js");
    const ws = join(dir, "ws3");
    mkdirSync(ws, { recursive: true });
    expect(rememberNote(ws, "keep this")).toBe(true);
    writeMemory(ws, "the summary");
    expect(readMemory(ws)).toContain("the summary");
    expect(listNotes(join(ws, ".ambient", "MEMORY.md"), ws)).toEqual(["keep this"]);
  });
});
