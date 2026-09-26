import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NewEvent, ToolContext } from "@amb/protocol";
import { afterEach, beforeEach, expect, it } from "vitest";
import { bashTool } from "../src/tools/bash.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "amb-bashtree-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
// Git Bash reports its own (MSYS) pid for `$!`; the real Windows pid is in /proc/<pid>/winpid.
const PID_OF_LAST = process.platform === "win32" ? "cat /proc/$!/winpid" : "echo $!";
const posix = (p: string) => p.replace(/\\/g, "/");
const SLOW = process.platform === "win32" ? 30_000 : 5_000; // Windows process start/kill is slower

const ctx = (signal: AbortSignal): ToolContext => ({
  cwd: dir,
  workspaceRoot: dir,
  signal,
  secret: async () => "",
  emit: (_e: NewEvent) => {},
});

// A bash command that spawns a long-lived GRANDCHILD (`sleep`) under `/bin/sh -c`. On timeout, killing only
// the shell would orphan the sleep AND (holding the stdout pipe) hang the tool promise forever. The
// process-group kill must take the grandchild with it.
it(
  "bash timeout kills the whole process tree — no leaked grandchild, promise resolves",
  async () => {
    const pidFile = join(dir, "gc.pid");
    const out = await bashTool.execute(
      { command: `sleep 30 & ${PID_OF_LAST} > "${posix(pidFile)}"; wait`, timeoutMs: 1_500 },
      ctx(new AbortController().signal),
    );
    expect(out.timedOut).toBe(true); // the promise resolved (didn't hang)
    const gcPid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    expect(Number.isInteger(gcPid)).toBe(true);
    for (let i = 0; i < 40 && alive(gcPid); i++) await settle(25);
    expect(alive(gcPid)).toBe(false); // …and the grandchild sleep was killed with the group
  },
  SLOW,
);

it(
  "bash abort (Ctrl-C) kills the whole tree too",
  async () => {
    const pidFile = join(dir, "gc2.pid");
    const controller = new AbortController();
    const p = bashTool.execute(
      { command: `sleep 30 & ${PID_OF_LAST} > "${posix(pidFile)}"; wait`, timeoutMs: 60_000 },
      ctx(controller.signal),
    );
    await settle(process.platform === "win32" ? 3_000 : 200); // let the grandchild start
    controller.abort();
    await p; // must resolve, not hang
    const gcPid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    for (let i = 0; i < 40 && alive(gcPid); i++) await settle(25);
    expect(alive(gcPid)).toBe(false);
  },
  SLOW,
);

// The shell exits at once but leaves a background job holding the output pipe: the tool must still return
// (shortly after the shell exits) instead of waiting for the job — the `npm run dev &` case.
it(
  "returns soon after the shell exits even when a background job keeps the output open",
  async () => {
    const pidFile = join(dir, "bg.pid");
    const started = Date.now();
    const out = await bashTool.execute(
      {
        command: `sleep 20 & ${PID_OF_LAST} > "${posix(pidFile)}"; echo started`,
        timeoutMs: 60_000,
      },
      ctx(new AbortController().signal),
    );
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    try {
      expect(out.stdout).toContain("started");
      expect(out.timedOut).toBe(false);
      expect(Date.now() - started).toBeLessThan(SLOW);
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  },
  SLOW * 3,
);
