import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CiWatches } from "@amb/tools-core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Agent } from "../src/agent.js";
import { newRunState } from "../src/execute-tools.js";
import { FixtureClient, TEXT_200K, catalogOf, runOpts } from "./fixtures/catalog.js";

let dir: string;
const state = newRunState();
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "amb-steerwait-"));
});
afterEach(() => {
  state.jobs.stopAll();
  rmSync(dir, { recursive: true, force: true });
});
const call = (id: string, name: string, args: unknown) => ({
  content: "",
  toolCalls: [{ id, name, args, rawArgs: JSON.stringify(args) }],
});

it("a quiet wait makes no further requests until steering wakes it, preserving the job", async () => {
  const wake = new AbortController();
  let queued: string[] = [];
  let requests = 0;
  const client = new FixtureClient(catalogOf(TEXT_200K), [
    () => {
      requests++;
      return call("start", "bash", {
        command: 'node -e "setInterval(() => {}, 1000)"',
        background: true,
      });
    },
    () => {
      requests++;
      return call("wait", "bash_wait", { id: "bg1" });
    },
    (params) => {
      requests++;
      expect(JSON.stringify(params.messages)).toContain("diagnose now");
      return { content: "done", toolCalls: [] };
    },
  ]);
  const run = new Agent(client).run(
    "build",
    runOpts({
      mode: "bypass",
      requestedModel: TEXT_200K.id,
      cwd: dir,
      workspaceRoot: dir,
      maxTurns: 8,
      runState: state,
      waitSignal: () => wake.signal,
      steer: () => {
        const ready = queued;
        queued = [];
        return ready;
      },
    }),
  );
  try {
    const end = Date.now() + 5000;
    while (requests < 2 && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 80));
    expect(requests).toBe(2);
    queued = ["diagnose now"];
    wake.abort();
    expect((await run).stopReason).toBe("complete");
    expect(state.jobs.list()[0]?.exitCode).toBeUndefined();
  } finally {
    state.jobs.stopAll();
  }
});

it("hands a failed CI job to diagnosis while the remaining job keeps being monitored", async () => {
  let reads = 0;
  const ci = new CiWatches(
    {
      read: async () => {
        reads++;
        return {
          status: reads >= 3 ? "completed" : "in_progress",
          conclusion: reads >= 3 ? "failure" : "",
          url: "https://github.com/owner/repo/actions/runs/7",
          jobs: [
            { databaseId: 1, name: "build", status: "completed", conclusion: "failure" },
            {
              databaseId: 2,
              name: "tests",
              status: reads >= 3 ? "completed" : "in_progress",
              conclusion: reads >= 3 ? "success" : "",
            },
          ],
        };
      },
      logs: async () => "compiler error",
    },
    [5, 10, 20, 30],
  );
  const runState = { ...newRunState(), ci };
  const client = new FixtureClient(catalogOf(TEXT_200K), [
    call("ci", "watch_ci", { repo: "owner/repo", runId: 7 }),
    (params) => {
      expect(JSON.stringify(params.messages)).toContain("compiler error");
      return { content: "diagnosing build", toolCalls: [] };
    },
  ]);
  try {
    expect(
      (
        await new Agent(client).run(
          "check CI",
          runOpts({
            mode: "bypass",
            cwd: dir,
            workspaceRoot: dir,
            requestedModel: TEXT_200K.id,
            runState,
          }),
        )
      ).stopReason,
    ).toBe("complete");
    await new Promise((r) => setTimeout(r, 60));
    expect(reads).toBe(3);
  } finally {
    ci.stopAll();
    runState.jobs.stopAll();
    runState.tasks.stopAll();
  }
});
