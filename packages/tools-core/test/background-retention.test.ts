import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { BackgroundJobs } from "../src/background.js";
const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));
it("keeps a waited job until its final bytes are read even when many jobs finish together", async () => {
  spawn.mockImplementation(() =>
    Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    }),
  );
  const jobs = new BackgroundJobs();
  const first = jobs.start("fixture", process.cwd());
  const waiting = jobs.wait(first.id, { until: "exit", signal: new AbortController().signal });
  const firstChild = spawn.mock.results[0]?.value;
  firstChild.stdout.write("final output");
  firstChild.emit("close", 0);
  for (let i = 0; i < 20; i++) {
    jobs.start("fixture", process.cwd());
    spawn.mock.results.at(-1)?.value.emit("close", 0);
  }
  expect(await waiting).toMatchObject({ output: "final output", reason: "exit", running: false });
  expect(jobs.list().length).toBeLessThanOrEqual(16);
});
