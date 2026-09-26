import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverHooks } from "../src/hooks-config.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "amb-hookcfg-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("hook settings that aren't well formed", () => {
  it("are skipped instead of stopping ambient from starting", () => {
    const ws = join(dir, "ws");
    mkdirSync(join(ws, ".claude"), { recursive: true });
    writeFileSync(
      join(ws, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [null, 7, { hooks: [null, "x", { type: "command", command: "./ok.sh" }] }],
        },
      }),
    );
    const found = discoverHooks({ workspaceRoot: ws, home: join(dir, "home") });
    expect(found.project.map((h) => h.command)).toEqual(["./ok.sh"]);
  });
});
