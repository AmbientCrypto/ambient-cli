import { type CheckContext, evaluateCheck } from "./checks.js";
import type { CheckResult, EvalReport, EvalSuite, EvalTask, TaskResult } from "./types.js";

/** The result of running one task's agent, plus the workspace-bound ports its checks will read. */
export interface RunTaskOutcome {
  finalText: string;
  stopReason: string;
  /** The model that actually SERVED the run (for cross-model regression tracking). */
  model?: string;
  readFile: (relPath: string) => string | undefined;
  runCommand: (command: string) => Promise<number>;
  /**
   * Tear down the task's scratch workspace. The runner calls this AFTER the checks have read the workspace, in
   * a finally, so no scratch dir leaks (disk-hygiene rule). `runTask` must clean up itself if it THROWS before
   * returning; on success it hands cleanup here for the runner to invoke.
   */
  cleanup?: () => void | Promise<void>;
}

export interface EvalRunnerDeps {
  /**
   * Prepare an isolated workspace (write the task's setup files), run the agent on `task.prompt`, and return
   * the outcome + workspace-bound check ports. Supplied by the CLI edge (mktemp + the real Agent + spawn); the
   * edge OWNS teardown of the scratch workspace (disk-hygiene rule). Keeping it injected keeps this core pure.
   */
  runTask: (task: EvalTask) => Promise<RunTaskOutcome>;
  onTaskStart?: (task: EvalTask) => void;
  onTaskDone?: (result: TaskResult) => void;
}

/**
 * Run a suite task-by-task (sequential — a coding agent per task is heavy and tasks may run commands like
 * `npm test` that must not race), evaluate each task's checks against its post-run workspace, and aggregate.
 * A task passes only when EVERY check passes; a task whose run throws is a hard FAIL, never a silent skip.
 */
export async function runEvalSuite(suite: EvalSuite, deps: EvalRunnerDeps): Promise<EvalReport> {
  const results: TaskResult[] = [];
  for (const task of suite.tasks) {
    deps.onTaskStart?.(task);
    let result: TaskResult;
    let cleanup: (() => void | Promise<void>) | undefined;
    try {
      const outcome = await deps.runTask(task);
      cleanup = outcome.cleanup;
      const ctx: CheckContext = {
        finalText: outcome.finalText,
        stopReason: outcome.stopReason,
        readFile: outcome.readFile,
        runCommand: outcome.runCommand,
      };
      const checks: CheckResult[] = [];
      for (const c of task.checks) checks.push(await evaluateCheck(c, ctx));
      result = {
        id: task.id,
        passed: checks.every((c) => c.passed),
        ...(outcome.model ? { model: outcome.model } : {}),
        stopReason: outcome.stopReason,
        checks,
      };
    } catch (err) {
      result = {
        id: task.id,
        passed: false,
        checks: [
          {
            kind: "completed",
            passed: false,
            detail: `task run errored: ${(err as Error).message}`,
          },
        ],
      };
    } finally {
      // Always tear down the scratch workspace, even if a check threw — no scratch dir leaks (disk-hygiene).
      try {
        await cleanup?.();
      } catch {
        /* best-effort teardown */
      }
    }
    results.push(result);
    deps.onTaskDone?.(result);
  }
  const passed = results.filter((r) => r.passed).length;
  return {
    suite: suite.name,
    total: results.length,
    passed,
    passRate: results.length ? passed / results.length : 0,
    results,
  };
}
