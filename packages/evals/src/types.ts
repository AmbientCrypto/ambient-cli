import { z } from "zod";

/**
 * The private, repo-specific eval harness (Karpathy): each task is a prompt PLUS deterministic, checkable
 * success criteria (a file exists, a command exits 0, the answer contains a string). "Done" is coupled to
 * VERIFICATION — a task passes only when its checks pass, never on vibes — and running the suite across
 * model/prompt changes turns "did we regress?" into a number instead of a feeling. This module is the pure
 * contract + evaluation core; the agent and the filesystem are injected at the edge (CLI), so the runner is
 * fully testable without a network or a real workspace.
 */

/** A single deterministic success criterion for a task. Discriminated on `kind`. */
export const EvalCheck = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("file_exists"),
    path: z.string().min(1).describe("Workspace-relative path that must exist after the run"),
  }),
  z.object({
    kind: z.literal("file_contains"),
    path: z.string().min(1),
    text: z.string().min(1).describe("Substring the file must contain"),
  }),
  z.object({
    kind: z.literal("command_succeeds"),
    command: z.string().min(1).describe("Shell command that must exit 0 in the workspace"),
  }),
  z.object({
    kind: z.literal("output_contains"),
    text: z.string().min(1).describe("Substring the agent's final answer must contain"),
  }),
  z.object({
    kind: z.literal("completed"),
    // The run must end with stopReason "complete" (not blocked/looping/error/max_turns/cancelled).
  }),
]);
export type EvalCheck = z.infer<typeof EvalCheck>;

/** One eval task: a prompt, optional seed files, and the checks that define success. */
export const EvalTask = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  /** Files written into the isolated workspace BEFORE the agent runs (fixtures the task operates on). */
  setup: z
    .object({
      files: z.array(z.object({ path: z.string().min(1), content: z.string() })).default([]),
    })
    .optional(),
  checks: z
    .array(EvalCheck)
    .min(1)
    .describe("A task with no checks can't verify anything → disallowed"),
});
export type EvalTask = z.infer<typeof EvalTask>;

/** A named suite of tasks (one `.ambient/evals/<name>.json` file). Task ids must be unique — a duplicate id
 *  would make baseline regression tracking ambiguous (which `a` regressed?). */
export const EvalSuite = z
  .object({
    name: z.string().min(1),
    tasks: z.array(EvalTask).min(1),
  })
  .refine((s) => new Set(s.tasks.map((t) => t.id)).size === s.tasks.length, {
    message: "duplicate task ids (each task id must be unique)",
  });
export type EvalSuite = z.infer<typeof EvalSuite>;

/** The outcome of one check within a task run. */
export interface CheckResult {
  kind: EvalCheck["kind"];
  passed: boolean;
  detail: string;
}

/** The outcome of one task: it passes only if EVERY check passed. */
export interface TaskResult {
  id: string;
  passed: boolean;
  /** The model that actually served the run (requested→served may differ) — for cross-model regression. */
  model?: string;
  stopReason?: string;
  checks: CheckResult[];
}

/** The aggregate report for a suite run. */
export interface EvalReport {
  suite: string;
  total: number;
  passed: number;
  /** passed/total in [0,1]; 0 when total is 0 (an empty suite proves nothing). */
  passRate: number;
  results: TaskResult[];
}

/**
 * Runtime schema for a persisted report — used to VALIDATE a baseline file before comparing (a baseline is
 * read back from disk, so it's untrusted at that boundary). A malformed baseline (e.g. `"passed":"true"`)
 * would otherwise fail OPEN — a real regression wouldn't classify — so we parse it, not cast it.
 */
export const EvalReportSchema = z
  .object({
    suite: z.string(),
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    passRate: z.number().finite().min(0).max(1),
    results: z.array(
      z.object({
        id: z.string().min(1),
        passed: z.boolean(),
        model: z.string().optional(),
        stopReason: z.string().optional(),
        checks: z.array(
          z.object({
            kind: z.enum([
              "file_exists",
              "file_contains",
              "command_succeeds",
              "output_contains",
              "completed",
            ]),
            passed: z.boolean(),
            detail: z.string(),
          }),
        ),
      }),
    ),
  })
  .refine((r) => new Set(r.results.map((x) => x.id)).size === r.results.length, {
    message: "duplicate task ids in baseline report",
  });
