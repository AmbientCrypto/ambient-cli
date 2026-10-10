import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { BackgroundJobs } from "../src/background.js";

let dir: string;
let jobs: BackgroundJobs;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "amb-wait-"));
  jobs = new BackgroundJobs();
});
afterEach(() => {
  jobs.stopAll();
  rmSync(dir, { recursive: true, force: true });
});

it("waits quietly for close and includes the final stdout bytes", async () => {
  const { id } = jobs.start("node -e \"setTimeout(() => console.log('finished'), 180)\"", dir);
  const result = await jobs.wait(id, { until: "exit", signal: new AbortController().signal });
  expect(result.reason).toBe("exit");
  expect(result.running).toBe(false);
  expect(result.output).toContain("finished");
  expect(jobs.read(id).output).toBe("");
});
it("wakes on new output without stopping a running process", async () => {
  const { id } = jobs.start(
    "node -e \"setTimeout(() => console.log('ready'), 80); setTimeout(() => {}, 5000)\"",
    dir,
  );
  const result = await jobs.wait(id, { until: "output", signal: new AbortController().signal });
  expect(result.reason).toBe("output");
  expect(result.output).toContain("ready");
  expect(result.running).toBe(true);
});
it("steering and explicit deadlines wake waits without killing the command", async () => {
  const { id } = jobs.start('node -e "setInterval(() => {}, 1000)"', dir);
  const wake = new AbortController();
  const waiting = jobs.wait(id, {
    until: "exit",
    signal: new AbortController().signal,
    wakeSignal: wake.signal,
  });
  wake.abort();
  expect((await waiting).reason).toBe("steered");
  expect(
    (await jobs.wait(id, { until: "exit", signal: new AbortController().signal, timeoutMs: 10 }))
      .reason,
  ).toBe("timeout");
  expect(jobs.list()[0]?.exitCode).toBeUndefined();
});
it("handles pre-aborted cancellation, completed targets and invalid ids", async () => {
  const { id } = jobs.start('node -e "setTimeout(() => {}, 100)"', dir);
  expect((await jobs.wait(id, { until: "exit", signal: AbortSignal.abort() })).reason).toBe(
    "cancelled",
  );
  await jobs.wait(id, { until: "exit", signal: new AbortController().signal });
  expect(
    (await jobs.wait(id, { until: "exit", signal: new AbortController().signal })).reason,
  ).toBe("exit");
  await expect(
    jobs.wait("missing", { until: "exit", signal: new AbortController().signal }),
  ).rejects.toThrow("no background command");
});
