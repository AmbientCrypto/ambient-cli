import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isReadOnlyCommand } from "../src/read-only-command.js";
import { parseShellCommands } from "../src/shell-tokens.js";

/**
 * Differential test for the auto-approval gate: every command the gate calls read-only is run in real bash
 * with each allowed command replaced by a function that only records its arguments, and nothing else on
 * PATH. Every command bash runs must be one the gate checked, with the same arguments — otherwise the gate
 * reasoned about a different command than the one that would run.
 */
const NAMES = ["ls", "cat", "grep", "rg", "git", "echo", "head", "wc", "tree", "date"];
const WORDS = [
  ...NAMES,
  "-n",
  "-la",
  "--stat",
  "--format=%H",
  "log",
  "status",
  "src",
  "a.ts",
  "'a b'",
  '"x y"',
  "'$HOME'",
  '"a*b"',
  "HEAD~1",
  "issue#4",
  "x=1",
  "*",
  "~",
  "#",
  "{a,b}",
  "$X",
  "'",
  '"',
  ";",
  "a'b'c",
  '"q"r',
  "--",
  "é",
];
const OPS = [" ", " ", " ", "; ", " && ", " | ", " || ", "\n", " & ", "\t"];

/** A deterministic pseudo-random command generator (same corpus every run). */
function* corpus(n: number): Generator<string> {
  let seed = 12345;
  const rnd = (k: number) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % k;
  };
  for (let i = 0; i < n; i++) {
    const parts: string[] = [NAMES[rnd(NAMES.length)] as string];
    const len = 1 + rnd(6);
    for (let j = 0; j < len; j++) {
      parts.push(OPS[rnd(OPS.length)] as string);
      parts.push(WORDS[rnd(WORDS.length)] as string);
    }
    yield parts.join("");
  }
}

/** Run `cmd` in bash where each allowed command only records `name\x1farg\x1f…\x1e`. */
function bashInvocations(cmd: string, cwd: string): string[][] {
  // One printf per record: background (&) jobs share the pipe, and a single small write never interleaves.
  const fns = NAMES.map(
    (n) => `${n}() { local r; r=$(printf '%s\\x1f' ${n} "$@"); printf '%s\\x1e' "$r"; }`,
  ).join("\n");
  const script = `${fns}\ncommand_not_found_handle() { printf 'UNEXPECTED\\x1f%s\\x1e' "$1"; }\n${cmd}\nwait`;
  const r = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", script], {
    cwd,
    env: { PATH: cwd, HOME: "/nonexistent-home", X: "set" },
    encoding: "utf8",
    timeout: 5_000,
  });
  return (r.stdout ?? "")
    .split("\x1e")
    .filter((s) => s.length > 0)
    .map((s) => s.split("\x1f").slice(0, -1));
}

describe.runIf(process.platform !== "win32")(
  "read-only gate matches what bash actually runs",
  () => {
    it("never approves a command bash would run differently", () => {
      const dir = mkdtempSync(join(tmpdir(), "amb-parity-"));
      try {
        const mismatches: string[] = [];
        let approved = 0;
        for (const cmd of corpus(4_000)) {
          if (!isReadOnlyCommand(cmd)) continue;
          approved++;
          const expected = parseShellCommands(cmd).map((s) => s.argv);
          const actual = bashInvocations(cmd, dir);
          // Safety property: everything bash runs is something the gate checked (as a multiset). Bash may run
          // FEWER — `a || b` skips b when a succeeds, and a syntax error runs nothing — which is always safe.
          const pool = expected.map((x) => JSON.stringify(x));
          const extra = actual
            .map((x) => JSON.stringify(x))
            .filter((x) => {
              const i = pool.indexOf(x);
              if (i < 0) return true;
              pool.splice(i, 1);
              return false;
            });
          if (extra.length > 0) {
            mismatches.push(
              `${JSON.stringify(cmd)} → gate ${JSON.stringify(expected)} vs bash ran ${extra.join(" ")}`,
            );
          }
        }
        expect(approved).toBeGreaterThan(100); // the corpus really exercises the approve path
        expect(mismatches.slice(0, 10)).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 120_000);
  },
);
