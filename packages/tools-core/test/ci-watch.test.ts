import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CiWatches } from "../src/ci-watch.js";

const input = { repo: "owner/repo", runId: 42 };
const running = {
  status: "in_progress",
  conclusion: "",
  url: "https://github.com/owner/repo/actions/runs/42",
  jobs: [
    { databaseId: 1, name: "build", status: "in_progress", conclusion: "" },
    { databaseId: 2, name: "tests", status: "in_progress", conclusion: "" },
  ],
};
const failed = {
  ...running,
  jobs: [{ ...running.jobs[0], status: "completed", conclusion: "failure" }, running.jobs[1]],
};
const done = {
  ...failed,
  status: "completed",
  conclusion: "failure",
  jobs: [failed.jobs[0], { ...running.jobs[1], status: "completed", conclusion: "success" }],
};
let watches: CiWatches;
const opts = () => ({ signal: new AbortController().signal });
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  watches?.stopAll();
  vi.useRealTimers();
});

describe("GitHub CI waits", () => {
  it("returns the first failure and bounded logs while monitoring remaining jobs", async () => {
    let reads = 0;
    watches = new CiWatches(
      {
        read: async () => [running, failed, done][Math.min(reads++, 2)],
        logs: async () => "x".repeat(40_000),
      },
      [10, 20, 40, 60],
    );
    const waiting = watches.wait(input, opts());
    await vi.advanceTimersByTimeAsync(10);
    const first = await waiting;
    expect(first.reason).toBe("failure");
    expect(first.running).toBe(true);
    expect(first.failedJobs.map((job) => job.databaseId)).toEqual([1]);
    expect(first.logs.length).toBeLessThanOrEqual(30_000);
    await vi.advanceTimersByTimeAsync(10);
    expect(reads).toBe(3);
    expect((await watches.wait(input, opts())).reason).toBe("complete");
    expect(watches.takeUpdates().some((update) => update.includes("completed"))).toBe(true);
  });
  it("backs off on unchanged status and steering wakes only the wait", async () => {
    let reads = 0;
    const wake = new AbortController();
    watches = new CiWatches(
      {
        read: async () => {
          reads++;
          return running;
        },
        logs: async () => "",
      },
      [10, 20, 40, 60],
    );
    const waiting = watches.wait(input, { ...opts(), wakeSignal: wake.signal });
    await vi.advanceTimersByTimeAsync(130);
    expect(reads).toBe(5);
    wake.abort();
    expect((await waiting).reason).toBe("steered");
    await vi.advanceTimersByTimeAsync(60);
    expect(reads).toBe(6);
  });
  it("retries temporary failures and reports terminal authentication errors", async () => {
    let reads = 0;
    watches = new CiWatches(
      {
        read: async () => {
          if (++reads < 3) throw new Error("network unavailable");
          return { ...done, conclusion: "success", jobs: [] };
        },
        logs: async () => "",
      },
      [10, 20, 40, 60],
    );
    const waiting = watches.wait(input, opts());
    await vi.advanceTimersByTimeAsync(70);
    expect((await waiting).reason).toBe("complete");
    watches.stopAll();
    watches = new CiWatches(
      {
        read: async () => {
          throw new Error("gh auth login required");
        },
        logs: async () => "",
      },
      [10, 20, 40, 60],
    );
    expect((await watches.wait(input, opts())).error).toContain("gh auth login");
  });
  it("rejects malformed targets and cleans up polling after cancellation of the session", async () => {
    let reads = 0;
    watches = new CiWatches(
      {
        read: async () => {
          reads++;
          return running;
        },
        logs: async () => "",
      },
      [10, 20, 40, 60],
    );
    await expect(watches.wait({ ...input, repo: "--unsafe" }, opts())).rejects.toThrow();
    const waiting = watches.wait(input, opts());
    await vi.advanceTimersByTimeAsync(0);
    watches.stopAll();
    expect((await waiting).reason).toBe("cancelled");
    await vi.advanceTimersByTimeAsync(1000);
    expect(reads).toBe(1);
  });
});
