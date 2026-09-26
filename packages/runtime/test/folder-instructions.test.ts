import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../src/agent.js";
import { FixtureClient, TEXT_200K, catalogOf, memWorkspace, runOpts } from "./fixtures/catalog.js";

let ws: string;
beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), "amb-folder-instr-")));
  mkdirSync(join(ws, "packages", "api"), { recursive: true });
  writeFileSync(join(ws, "packages", "api", "a.ts"), "export const a = 1;");
  writeFileSync(join(ws, "packages", "api", "b.ts"), "export const b = 2;");
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const read = (path: string, id: string) => ({
  content: "",
  toolCalls: [{ id, name: "read", args: { path }, rawArgs: JSON.stringify({ path }) }],
});

describe("a subfolder's own instructions", () => {
  it("arrive with the first call into that folder, once", async () => {
    const asked: string[] = [];
    const workspace = {
      ...memWorkspace(),
      folderInstructions: (dir: string) => {
        asked.push(dir.slice(ws.length));
        return dir.endsWith(join("packages", "api"))
          ? "API RULE: validate every input with zod"
          : undefined;
      },
    };
    const client = new FixtureClient(catalogOf(TEXT_200K), [
      read("packages/api/a.ts", "c1"),
      read("packages/api/b.ts", "c2"),
      { content: "done", toolCalls: [] },
    ]);
    await new Agent(client).run(
      "look at the api",
      runOpts({ requestedModel: TEXT_200K.id, cwd: ws, workspaceRoot: ws, workspace }),
    );
    const results = client.calls.flatMap((c) =>
      c.messages.filter((m) => m.role === "tool").map((m) => String(m.content)),
    );
    const first = results.find((r) => r.includes("export const a"));
    const second = results.find((r) => r.includes("export const b"));
    expect(first).toContain(
      "Instructions for packages/api/ (follow them while working there):\nAPI RULE",
    );
    expect(second).not.toContain("API RULE");
    expect(asked).toEqual([`${sep}packages`, `${sep}${join("packages", "api")}`]);
  });
});
