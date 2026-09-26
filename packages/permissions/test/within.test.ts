import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { decide, isWithinWorkspace, resolveResource } from "../src/index.js";

describe("workspace containment (resource paths)", () => {
  it("resolves relative paths against the root and normalizes ..", () => {
    expect(resolveResource("/w/proj", "src/a.ts")).toBe(resolve("/w/proj", "src/a.ts"));
    expect(isWithinWorkspace("/w/proj", resolveResource("/w/proj", "src/../b.ts"))).toBe(true);
    expect(isWithinWorkspace("/w/proj", resolveResource("/w/proj", "../secret.txt"))).toBe(false);
    expect(isWithinWorkspace("/w/proj", resolveResource("/w/proj", "/w/proj/../other/x"))).toBe(
      false,
    );
    expect(isWithinWorkspace("/w/proj", "/w/project-evil/x")).toBe(false); // prefix-only match is not inside
    expect(isWithinWorkspace("/w/proj", "/w/proj")).toBe(true);
  });

  it("a write that escapes with .. is refused outside bypass", () => {
    const d = decide({
      principal: "model",
      mode: "accept-edits",
      toolName: "mcp__fs__write_file",
      effects: ["write"],
      normalizedArgs: {},
      resolvedResources: [resolveResource("/w/proj", "../../etc/passwd")],
      workspaceRoot: "/w/proj",
      grants: [{ toolName: "mcp__fs__write_file", scope: "session" }],
    });
    expect(d.effect).toBe("deny");
  });

  it.runIf(process.platform === "win32")("reads Git Bash /c/... paths as drive paths", () => {
    expect(isWithinWorkspace("C:\\proj", resolveResource("C:\\proj", "/c/proj/src/a.ts"))).toBe(
      true,
    );
    expect(isWithinWorkspace("C:\\proj", resolveResource("C:\\proj", "/d/other"))).toBe(false);
  });
});
