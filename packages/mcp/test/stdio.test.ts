import { expect, it } from "vitest";
import { spawnStdioTransport } from "../src/stdio.js";

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// A wrapper process (`sh`) that launches a long-lived GRANDCHILD (`sleep`) and prints its pid — this mirrors
// how real MCP servers run under `npm exec`/`npx`/`uvx`. close() must kill the whole group, not just `sh`,
// or the grandchild orphans AND keeps our stdout pipe open (the CLI then hangs after [complete]).
it("close() kills the whole process group — no orphaned grandchild, pipes released", async () => {
  const { transport, child } = spawnStdioTransport({
    // On Windows use Git's real sh (usr\bin), not the bin\ launcher.
    command:
      process.platform === "win32"
        ? `${process.env.ProgramFiles ?? "C:\\Program Files"}\\Git\\usr\\bin\\sh.exe`
        : "sh",
    // Git Bash's `sh` reports an MSYS pid for `$!`; the real Windows pid is in /proc/<pid>/winpid.
    args: [
      "-c",
      `sleep 30 & ${process.platform === "win32" ? "cat /proc/$!/winpid" : "echo $!"} ; wait`,
    ],
  });
  // Read the grandchild pid off stdout (a second listener; the framer also sees it and ignores the non-JSON).
  let out = "";
  child.stdout?.on("data", (d: string) => {
    out += d;
  });
  for (let i = 0; i < 200 && !/\d/.test(out); i++) await settle(25);
  const gcPid = Number.parseInt(out.trim(), 10);
  expect(Number.isInteger(gcPid)).toBe(true);
  expect(alive(gcPid)).toBe(true); // the grandchild sleep is running

  transport.close();
  for (let i = 0; i < 200 && alive(gcPid); i++) await settle(25);
  expect(alive(gcPid)).toBe(false); // …and dies with the group (not orphaned)
}, 30_000);

it("a server doesn't inherit ambient's own API key unless its config passes it", async () => {
  const { serverEnv } = await import("../src/stdio.js");
  const before = process.env.AMBIENT_API_KEY;
  process.env.AMBIENT_API_KEY = "amb-test-key";
  try {
    expect(serverEnv(undefined).AMBIENT_API_KEY).toBeUndefined();
    expect(serverEnv(undefined).PATH).toBe(process.env.PATH);
    expect(serverEnv({ AMBIENT_API_KEY: "on purpose" }).AMBIENT_API_KEY).toBe("on purpose");
  } finally {
    if (before === undefined) Reflect.deleteProperty(process.env, "AMBIENT_API_KEY");
    else process.env.AMBIENT_API_KEY = before;
  }
});
