import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { GithubCiReader } from "../src/github-ci.js";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));
afterEach(() => spawn.mockReset());
const target = { repo: "owner/repo", runId: 42 };
const snapshot = {
  status: "completed",
  conclusion: "success",
  url: "https://github.com/owner/repo/actions/runs/42",
  jobs: [],
};
function child(text: string, code = 0, stderr = "", error?: Error) {
  spawn.mockImplementationOnce(() => {
    const process = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    queueMicrotask(() => {
      if (error) process.emit("error", error);
      else {
        process.stdout.write(text);
        process.stderr.write(stderr);
        process.emit("close", code);
      }
    });
    return process;
  });
}
it("uses fixed gh arguments and validates the response", async () => {
  child(JSON.stringify(snapshot));
  expect(await new GithubCiReader().read(target, new AbortController().signal)).toEqual(snapshot);
  expect(spawn.mock.calls[0]?.slice(0, 2)).toEqual([
    "gh",
    ["run", "view", "42", "--repo", "owner/repo", "--json", "status,conclusion,url,jobs"],
  ]);
  child("not JSON");
  await expect(new GithubCiReader().read(target, new AbortController().signal)).rejects.toThrow();
});
it("reports missing gh and authentication errors clearly", async () => {
  child("", 0, "", new Error("ENOENT"));
  await expect(new GithubCiReader().read(target, new AbortController().signal)).rejects.toThrow(
    /Install gh/,
  );
  child("", 1, "gh auth login required");
  await expect(new GithubCiReader().read(target, new AbortController().signal)).rejects.toThrow(
    /gh auth login/,
  );
});
it("bounds JSON and log output, and handles unavailable logs", async () => {
  child("x".repeat(3 * 1024 * 1024));
  await expect(new GithubCiReader().read(target, new AbortController().signal)).rejects.toThrow(
    /safe size/,
  );
  child("x".repeat(50000));
  expect((await new GithubCiReader().logs(target, 7, new AbortController().signal)).length).toBe(
    30000,
  );
  expect(spawn.mock.calls[1]?.[1]).toEqual([
    "api",
    "repos/owner/repo/actions/jobs/7/logs",
    "--allow-escape-sequences",
  ]);
  child("", 1, "permission denied");
  expect(await new GithubCiReader().logs(target, 7, new AbortController().signal)).toContain(
    "Logs unavailable",
  );
});
it("accepts colored GitHub logs and removes terminal control sequences", async () => {
  child("\u001b[31mfailed\u001b[0m\n\u001b[2Jdetails");
  expect(await new GithubCiReader().logs(target, 7, new AbortController().signal)).toBe(
    "failed\ndetails",
  );
});
it("does not spawn for an already cancelled request", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(new GithubCiReader().read(target, controller.signal)).rejects.toThrow(/cancelled/);
  expect(spawn).not.toHaveBeenCalled();
});
