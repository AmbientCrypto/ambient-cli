import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatParams } from "@amb/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../src/agent.js";
import { newRunState } from "../src/execute-tools.js";
import { FixtureClient, TEXT_200K, catalogOf, runOpts } from "./fixtures/catalog.js";

let ws: string;
beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), "amb-bgrun-")));
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const bash = (id: string, command: string, background = false) => ({
  content: "",
  toolCalls: [
    {
      id,
      name: "bash",
      args: { command, ...(background ? { background: true } : {}) },
      rawArgs: JSON.stringify({ command, background }),
    },
  ],
});

describe("background commands in a run", () => {
  it("the model is told when one finishes, and a run on its own stops what it started", async () => {
    let sawNote = false;
    const client = new FixtureClient(catalogOf(TEXT_200K), [
      bash("tc_1", `node -e "console.log('built')"`, true),
      bash("tc_2", `node -e "setInterval(() => {}, 1000)"`, true),
      bash("tc_3", `node -e "setTimeout(() => {}, 600)"`),
      (p: ChatParams) => {
        sawNote = JSON.stringify(p.messages).includes("Background command bg1");
        return { content: "done", toolCalls: [] };
      },
    ]);
    const state = newRunState();
    await new Agent(client).run(
      "build",
      runOpts({
        requestedModel: TEXT_200K.id,
        mode: "bypass",
        cwd: ws,
        workspaceRoot: ws,
        maxTurns: 8,
        runState: state,
      }),
    );
    expect(sawNote).toBe(true);
    // A session's state keeps its commands running between messages…
    expect(state.jobs.list().find((j) => j.id === "bg2")?.exitCode).toBeUndefined();
    state.jobs.stopAll();

    // …while a run with no session state stops them when it ends: the process it started is gone.
    const pidFile = join(ws, "server.pid").replace(/\\/g, "/");
    const client2 = new FixtureClient(catalogOf(TEXT_200K), [
      bash(
        "tc_1",
        `node -e "require('fs').writeFileSync('${pidFile}', String(process.pid)); setInterval(() => {}, 1000)"`,
        true,
      ),
      bash("tc_2", `node -e "setTimeout(() => {}, 400)"`),
      { content: "done", toolCalls: [] },
    ]);
    await new Agent(client2).run(
      "serve",
      runOpts({
        requestedModel: TEXT_200K.id,
        mode: "bypass",
        cwd: ws,
        workspaceRoot: ws,
        maxTurns: 6,
      }),
    );
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(pid).toBeGreaterThan(0);
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const t0 = Date.now();
    while (alive() && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 50));
    expect(alive()).toBe(false);
  });
});
