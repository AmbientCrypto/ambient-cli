import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@amb/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BackgroundJobs } from "../src/background.js";
import { bashOutputTool, killShellTool } from "../src/tools/background-tools.js";
import { bashTool } from "../src/tools/bash.js";

const waitFor = async (fn: () => boolean, ms = 10_000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};

let dir: string;
let jobs: BackgroundJobs;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "amb-bg-"));
  jobs = new BackgroundJobs();
});
afterEach(() => {
  jobs.stopAll();
  rmSync(dir, { recursive: true, force: true });
});

const ctx = (): ToolContext => ({
  cwd: dir,
  workspaceRoot: dir,
  signal: new AbortController().signal,
  secret: async () => "",
  emit: () => {},
  backgroundJobs: jobs,
});

describe("background commands", () => {
  it("start, report output incrementally, and say when they finish (once)", async () => {
    const finished: string[] = [];
    jobs.onFinish((j) => finished.push(`${j.id}:${j.exitCode}`));
    const started = await bashTool.execute(
      {
        command: `node -e "console.log('one'); setTimeout(() => console.log('two'), 300)"`,
        timeoutMs: 120_000,
        background: true,
      },
      ctx(),
    );
    expect(started.backgroundId).toBe("bg1");
    await waitFor(() => jobs.list()[0]?.exitCode !== undefined);
    const first = await bashOutputTool.execute({ id: "bg1" }, ctx());
    expect(first.output).toContain("one");
    expect(first.output).toContain("two");
    expect(first.running).toBe(false);
    expect(first.exitCode).toBe(0);
    const again = await bashOutputTool.execute({ id: "bg1" }, ctx());
    expect(again.output).toBe(""); // only what's new
    expect(finished).toEqual(["bg1:0"]);
    expect(jobs.takeFinished()).toEqual([]); // the model already read it
  });

  it("lets go of old finished commands the agent has already read", async () => {
    for (let i = 0; i < 20; i++) {
      const { id } = jobs.start("echo hi", dir);
      await waitFor(() => jobs.list().find((j) => j.id === id)?.exitCode !== undefined);
      jobs.read(id);
    }
    expect(jobs.list().length).toBeLessThanOrEqual(17);
    expect(jobs.list().at(-1)?.id).toBe("bg20");
  }, 30_000);

  it("kill_shell stops a running command; stopAll stops the rest", async () => {
    jobs.start(`node -e "setInterval(() => console.log('tick'), 100)"`, dir);
    jobs.start(`node -e "setInterval(() => {}, 1000)"`, dir);
    let seen = "";
    await waitFor(() => {
      seen += jobs.read("bg1").output;
      return seen.includes("tick");
    });
    expect((await killShellTool.execute({ id: "bg1" }, ctx())).stopped).toBe(true);
    await waitFor(() => jobs.list()[0]?.exitCode !== undefined);
    expect(jobs.list()[1]?.exitCode).toBeUndefined();
    jobs.stopAll();
    await waitFor(() => jobs.list().every((j) => j.exitCode !== undefined));
    expect(await killShellTool.execute({ id: "bg1" }, ctx())).toEqual({
      id: "bg1",
      stopped: false,
    });
  });

  it("the model hears about a finished command it hasn't read", async () => {
    jobs.start(`node -e "process.exit(3)"`, dir);
    await waitFor(() => jobs.list()[0]?.exitCode !== undefined);
    expect(jobs.takeFinished().map((j) => [j.id, j.exitCode])).toEqual([["bg1", 3]]);
    expect(jobs.takeFinished()).toEqual([]);
  });

  it("explains a bad id and a session without background support", async () => {
    await expect(bashOutputTool.execute({ id: "bg9" }, ctx())).rejects.toThrow(
      /no background command bg9/,
    );
    const { backgroundJobs: _none, ...plain } = ctx();
    await expect(
      bashTool.execute({ command: "echo x", timeoutMs: 1000, background: true }, plain),
    ).rejects.toThrow(/aren't available/);
  });
});
