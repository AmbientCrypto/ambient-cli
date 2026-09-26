import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fromGitBashPath, isReservedWindowsSegment, resolveInWorkspace } from "../src/paths.js";

describe("absolute paths through a symlinked root (macOS /var → /private/var, Windows junctions)", () => {
  it("accepts an absolute path spelled via the typed root, not only the real one", () => {
    const typed = mkdtempSync(join(tmpdir(), "amb-root-"));
    try {
      const out = resolveInWorkspace(typed, join(typed, "src", "a.ts"));
      expect(out).toBe(join(realpathSync.native(typed), "src", "a.ts"));
    } finally {
      rmSync(typed, { recursive: true, force: true });
    }
  });
});

describe("Windows path helpers", () => {
  it("converts Git-Bash style /c/Users/x to C:\\Users\\x", () => {
    expect(fromGitBashPath("/c/Users/me/proj/a.ts")).toBe(String.raw`C:\Users\me\proj\a.ts`);
    expect(fromGitBashPath("/usr/bin")).toBeUndefined();
    expect(fromGitBashPath("src/a.ts")).toBeUndefined();
  });
  it("flags reserved device names and alternate data streams", () => {
    for (const s of [
      "con",
      "NUL.txt",
      "aux.js",
      "COM1",
      "lpt9.log",
      "file.txt:secret",
      "CONIN$",
      "conout$.x",
      "COM\u00B9",
    ])
      expect(isReservedWindowsSegment(s), s).toBe(true);
    for (const s of ["console.ts", "contact.md", "src", "a.b.c"])
      expect(isReservedWindowsSegment(s), s).toBe(false);
  });
});
