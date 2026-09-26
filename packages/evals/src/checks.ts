import type { CheckResult, EvalCheck } from "./types.js";

/**
 * Everything a check needs to decide pass/fail — injected so the evaluator is PURE and testable without a real
 * filesystem, shell, or network. `readFile` returns undefined for a missing/unreadable path; `runCommand`
 * returns the command's exit code (0 = success). The agent's own outcome (finalText/stopReason) rides here too.
 */
export interface CheckContext {
  finalText: string;
  stopReason: string;
  readFile: (relPath: string) => string | undefined;
  runCommand: (command: string) => Promise<number>;
}

/** Read via the injected port, treating ANY throw (e.g. EACCES) as "unreadable" so evaluateCheck never throws
 * — honoring its contract for direct package consumers too, not just runEvalSuite's catch. */
function safeRead(ctx: CheckContext, path: string): string | undefined {
  try {
    return ctx.readFile(path);
  } catch {
    return undefined;
  }
}

/** Evaluate ONE deterministic success criterion against a completed run. Never throws — a failure is data. */
export async function evaluateCheck(check: EvalCheck, ctx: CheckContext): Promise<CheckResult> {
  switch (check.kind) {
    case "file_exists": {
      const passed = safeRead(ctx, check.path) !== undefined;
      return {
        kind: check.kind,
        passed,
        detail: passed ? `${check.path} exists` : `${check.path} is missing`,
      };
    }
    case "file_contains": {
      const content = safeRead(ctx, check.path);
      if (content === undefined)
        return { kind: check.kind, passed: false, detail: `${check.path} is missing` };
      const passed = content.includes(check.text);
      return {
        kind: check.kind,
        passed,
        detail: passed
          ? `${check.path} contains "${check.text}"`
          : `${check.path} does not contain "${check.text}"`,
      };
    }
    case "command_succeeds": {
      let code: number;
      try {
        code = await ctx.runCommand(check.command);
      } catch (err) {
        return {
          kind: check.kind,
          passed: false,
          detail: `\`${check.command}\` errored: ${(err as Error).message}`,
        };
      }
      const passed = code === 0;
      return {
        kind: check.kind,
        passed,
        detail: passed ? `\`${check.command}\` exited 0` : `\`${check.command}\` exited ${code}`,
      };
    }
    case "output_contains": {
      const passed = ctx.finalText.includes(check.text);
      return {
        kind: check.kind,
        passed,
        detail: passed
          ? `answer contains "${check.text}"`
          : `answer does not contain "${check.text}"`,
      };
    }
    case "completed": {
      const passed = ctx.stopReason === "complete";
      return {
        kind: check.kind,
        passed,
        detail: passed ? "run completed cleanly" : `run ended as "${ctx.stopReason}"`,
      };
    }
  }
}
