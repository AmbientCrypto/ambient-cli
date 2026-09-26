import { describe, expect, it } from "vitest";
import {
  type CheckContext,
  type EvalReport,
  type EvalSuite,
  type RunTaskOutcome,
  compareToBaseline,
  evalGate,
  evaluateCheck,
  formatReport,
  parseReport,
  parseSuite,
  parseSuiteJson,
  runEvalSuite,
} from "../src/index.js";

const baseCtx = (over: Partial<CheckContext> = {}): CheckContext => ({
  finalText: "",
  stopReason: "complete",
  readFile: () => undefined,
  runCommand: async () => 0,
  ...over,
});

describe("evaluateCheck (deterministic success criteria)", () => {
  it("file_exists — passes when the reader finds the path, fails when missing", async () => {
    const present = await evaluateCheck(
      { kind: "file_exists", path: "out.txt" },
      baseCtx({ readFile: (p) => (p === "out.txt" ? "hi" : undefined) }),
    );
    expect(present.passed).toBe(true);
    const absent = await evaluateCheck({ kind: "file_exists", path: "out.txt" }, baseCtx());
    expect(absent.passed).toBe(false);
    expect(absent.detail).toContain("missing");
  });

  it("file_contains — needs the file AND the substring", async () => {
    const ctx = baseCtx({ readFile: () => "export const x = 1;" });
    expect(
      (await evaluateCheck({ kind: "file_contains", path: "a.ts", text: "const x" }, ctx)).passed,
    ).toBe(true);
    expect(
      (await evaluateCheck({ kind: "file_contains", path: "a.ts", text: "const y" }, ctx)).passed,
    ).toBe(false);
    // a missing file fails file_contains (not a crash)
    const missing = await evaluateCheck(
      { kind: "file_contains", path: "a.ts", text: "x" },
      baseCtx(),
    );
    expect(missing.passed).toBe(false);
  });

  it("command_succeeds — 0 passes, non-zero fails, a throw is a fail (never propagates)", async () => {
    expect(
      (
        await evaluateCheck(
          { kind: "command_succeeds", command: "npm test" },
          baseCtx({ runCommand: async () => 0 }),
        )
      ).passed,
    ).toBe(true);
    expect(
      (
        await evaluateCheck(
          { kind: "command_succeeds", command: "npm test" },
          baseCtx({ runCommand: async () => 1 }),
        )
      ).passed,
    ).toBe(false);
    const threw = await evaluateCheck(
      { kind: "command_succeeds", command: "boom" },
      baseCtx({
        runCommand: async () => {
          throw new Error("spawn failed");
        },
      }),
    );
    expect(threw.passed).toBe(false);
    expect(threw.detail).toContain("spawn failed");
  });

  it("a throwing reader (e.g. EACCES) yields a failed check, never a throw (contract)", async () => {
    const throwing = baseCtx({
      readFile: () => {
        throw new Error("EACCES");
      },
    });
    await expect(
      evaluateCheck({ kind: "file_exists", path: "x" }, throwing),
    ).resolves.toMatchObject({
      passed: false,
    });
    await expect(
      evaluateCheck({ kind: "file_contains", path: "x", text: "y" }, throwing),
    ).resolves.toMatchObject({ passed: false });
  });

  it("output_contains + completed — check the run's own outcome", async () => {
    expect(
      (
        await evaluateCheck(
          { kind: "output_contains", text: "done" },
          baseCtx({ finalText: "all done" }),
        )
      ).passed,
    ).toBe(true);
    expect(
      (await evaluateCheck({ kind: "completed" }, baseCtx({ stopReason: "complete" }))).passed,
    ).toBe(true);
    expect(
      (await evaluateCheck({ kind: "completed" }, baseCtx({ stopReason: "blocked" }))).passed,
    ).toBe(false);
  });
});

describe("runEvalSuite (a task passes only if EVERY check passes)", () => {
  const suite: EvalSuite = {
    name: "s",
    tasks: [
      {
        id: "writes-file",
        prompt: "create out.txt",
        checks: [{ kind: "completed" }, { kind: "file_exists", path: "out.txt" }],
      },
      {
        id: "fails-a-check",
        prompt: "do the thing",
        checks: [{ kind: "file_exists", path: "never.txt" }],
      },
    ],
  };

  it("aggregates pass/fail and computes the pass rate", async () => {
    const outcomes: Record<string, RunTaskOutcome> = {
      "writes-file": {
        finalText: "created it",
        stopReason: "complete",
        model: "kimi",
        readFile: (p) => (p === "out.txt" ? "content" : undefined),
        runCommand: async () => 0,
      },
      "fails-a-check": {
        finalText: "did it",
        stopReason: "complete",
        readFile: () => undefined,
        runCommand: async () => 0,
      },
    };
    const report = await runEvalSuite(suite, {
      runTask: async (t) => outcomes[t.id] as RunTaskOutcome,
    });
    expect(report.total).toBe(2);
    expect(report.passed).toBe(1);
    expect(report.passRate).toBe(0.5);
    expect(report.results.find((r) => r.id === "writes-file")?.passed).toBe(true);
    expect(report.results.find((r) => r.id === "writes-file")?.model).toBe("kimi");
    expect(report.results.find((r) => r.id === "fails-a-check")?.passed).toBe(false);
  });

  it("a task whose RUN throws is a hard FAIL, never a silent skip", async () => {
    const report = await runEvalSuite(
      { name: "s", tasks: [{ id: "crashes", prompt: "x", checks: [{ kind: "completed" }] }] },
      {
        runTask: async () => {
          throw new Error("agent crashed");
        },
      },
    );
    expect(report.passed).toBe(0);
    expect(report.results[0]?.passed).toBe(false);
    expect(report.results[0]?.checks[0]?.detail).toContain("agent crashed");
  });
});

describe("regression gate (evals over vibes)", () => {
  const mk = (results: Array<[string, boolean]>): EvalReport => ({
    suite: "s",
    total: results.length,
    passed: results.filter(([, p]) => p).length,
    passRate: results.length ? results.filter(([, p]) => p).length / results.length : 0,
    results: results.map(([id, passed]) => ({ id, passed, checks: [] })),
  });

  it("compareToBaseline finds regressed (was-pass→now-fail) and fixed (was-fail→now-pass) tasks", () => {
    const baseline = mk([
      ["a", true],
      ["b", true],
      ["c", false],
    ]);
    const current = mk([
      ["a", true],
      ["b", false],
      ["c", true],
    ]);
    const diff = compareToBaseline(current, baseline);
    expect(diff.regressed).toEqual(["b"]);
    expect(diff.fixed).toEqual(["c"]);
    expect(diff.passRateDelta).toBeCloseTo(0); // 2/3 both ways
  });

  it("counts a REMOVED formerly-passing task as a regression (deletion can't evade the gate)", () => {
    const baseline = mk([
      ["a", true],
      ["b", true],
    ]);
    // Current dropped task "b" and replaced it with a new passing task "c": pass rate is still 100%…
    const current = mk([
      ["a", true],
      ["c", true],
    ]);
    const diff = compareToBaseline(current, baseline);
    expect(diff.regressed).toContain("b"); // …but the vanished passing task IS flagged
    expect(evalGate(current, { baseline }).blocked).toBe(true);
  });

  it("evalGate blocks on a regression even when the overall pass rate is unchanged", () => {
    const baseline = mk([
      ["a", true],
      ["b", true],
    ]);
    const current = mk([
      ["a", false],
      ["b", true],
    ]);
    const verdict = evalGate(current, { baseline });
    expect(verdict.blocked).toBe(true);
    expect(verdict.reasons.join(" ")).toContain("regressed");
  });

  it("evalGate blocks below the pass-rate floor and passes clean above it with no baseline", () => {
    expect(
      evalGate(
        mk([
          ["a", true],
          ["b", false],
        ]),
        { minPassRate: 0.75 },
      ).blocked,
    ).toBe(true);
    expect(
      evalGate(
        mk([
          ["a", true],
          ["b", true],
        ]),
        { minPassRate: 0.75 },
      ).blocked,
    ).toBe(false);
  });
});

describe("suite loading (validated at the boundary)", () => {
  it("parses a valid suite and rejects one with no checks (can't verify → invalid)", () => {
    const ok = parseSuite({
      name: "s",
      tasks: [{ id: "t", prompt: "p", checks: [{ kind: "completed" }] }],
    });
    expect(ok.tasks).toHaveLength(1);
    expect(() => parseSuite({ name: "s", tasks: [{ id: "t", prompt: "p", checks: [] }] })).toThrow(
      /invalid eval suite/,
    );
  });

  it("parseSuiteJson surfaces bad JSON and fills in a fallback name", () => {
    expect(() => parseSuiteJson("{not json", "fallback")).toThrow(/not valid JSON/);
    const s = parseSuiteJson(
      JSON.stringify({ tasks: [{ id: "t", prompt: "p", checks: [{ kind: "completed" }] }] }),
      "smoke",
    );
    expect(s.name).toBe("smoke");
  });

  it("rejects duplicate task ids (regression tracking would be ambiguous)", () => {
    expect(() =>
      parseSuite({
        name: "s",
        tasks: [
          { id: "dup", prompt: "p", checks: [{ kind: "completed" }] },
          { id: "dup", prompt: "q", checks: [{ kind: "completed" }] },
        ],
      }),
    ).toThrow(/duplicate task ids/);
  });

  it("parseReport validates a baseline instead of casting it (a string 'passed' is rejected)", () => {
    const good = {
      suite: "s",
      total: 1,
      passed: 1,
      passRate: 1,
      results: [{ id: "a", passed: true, checks: [] }],
    };
    expect(parseReport(good).results[0]?.passed).toBe(true);
    // A malformed baseline (passed is the STRING "true") must be REJECTED, not silently fail open.
    expect(() =>
      parseReport({ ...good, results: [{ id: "a", passed: "true", checks: [] }] }),
    ).toThrow(/invalid baseline report/);
  });
});

describe("formatReport", () => {
  it("renders the summary + only the failing checks", async () => {
    const report = await runEvalSuite(
      {
        name: "demo",
        tasks: [{ id: "t1", prompt: "x", checks: [{ kind: "file_exists", path: "z.txt" }] }],
      },
      {
        runTask: async () => ({
          finalText: "",
          stopReason: "complete",
          readFile: () => undefined,
          runCommand: async () => 0,
        }),
      },
    );
    const text = formatReport(report);
    expect(text).toContain('Eval suite "demo": 0/1 passed (0%)');
    expect(text).toContain("FAIL  t1");
    expect(text).toContain("✗ file_exists");
  });
});
