import type { EvalReport } from "./types.js";

const pct = (n: number): string => `${Math.round(n * 100)}%`;

/** A plain-text (no-ANSI, testable) rendering of a suite run — per-task pass/fail with failed-check details. */
export function formatReport(report: EvalReport): string {
  const lines: string[] = [
    `Eval suite "${report.suite}": ${report.passed}/${report.total} passed (${pct(report.passRate)})`,
    "",
  ];
  for (const r of report.results) {
    const mark = r.passed ? "PASS" : "FAIL";
    const model = r.model ? ` [${r.model}]` : "";
    lines.push(`  ${mark}  ${r.id}${model}`);
    // Show the failing checks (why it failed) — passing checks stay quiet to keep the report scannable.
    for (const c of r.checks) if (!c.passed) lines.push(`         ✗ ${c.kind}: ${c.detail}`);
  }
  return lines.join("\n");
}

/** What changed between a baseline run and the current run — the heart of regression tracking. */
export interface Regression {
  /** Task ids that PASSED in the baseline but FAIL now — the ship-blocking set. */
  regressed: string[];
  /** Task ids that FAILED in the baseline but PASS now — progress. */
  fixed: string[];
  /** current.passRate − baseline.passRate. */
  passRateDelta: number;
}

/** Diff a current report against a saved baseline to find regressions (and fixes). */
export function compareToBaseline(current: EvalReport, baseline: EvalReport): Regression {
  const basePass = new Map(baseline.results.map((r) => [r.id, r.passed]));
  const curById = new Map(current.results.map((r) => [r.id, r.passed]));
  const regressed: string[] = [];
  const fixed: string[] = [];
  for (const r of current.results) {
    const was = basePass.get(r.id);
    if (was === true && !r.passed) regressed.push(r.id);
    if (was === false && r.passed) fixed.push(r.id);
  }
  // A task that PASSED in the baseline but is GONE from the current run (removed/renamed) is a regression too —
  // otherwise deleting a failing-since-edit task silently evades the gate. Re-baseline when the
  // removal is intentional.
  for (const b of baseline.results) {
    if (b.passed && !curById.has(b.id)) regressed.push(b.id);
  }
  return { regressed, fixed, passRateDelta: current.passRate - baseline.passRate };
}

export interface GateVerdict {
  blocked: boolean;
  reasons: string[];
}

/**
 * The ship gate (Karpathy: "evals over vibes"). Blocks when the pass rate is below a floor OR any task that
 * used to pass now fails vs the baseline — so a model swap or prompt change that quietly breaks a real task
 * can't ship green. A pure decision; the CLI turns `blocked` into a non-zero exit code.
 */
export function evalGate(
  report: EvalReport,
  opts: { minPassRate?: number; baseline?: EvalReport } = {},
): GateVerdict {
  const reasons: string[] = [];
  if (opts.minPassRate !== undefined && report.passRate < opts.minPassRate) {
    reasons.push(
      `pass rate ${pct(report.passRate)} is below the required ${pct(opts.minPassRate)}`,
    );
  }
  if (opts.baseline) {
    const { regressed } = compareToBaseline(report, opts.baseline);
    if (regressed.length > 0) {
      reasons.push(`${regressed.length} task(s) regressed vs baseline: ${regressed.join(", ")}`);
    }
  }
  return { blocked: reasons.length > 0, reasons };
}
