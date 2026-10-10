import type { ToolDefinition } from "@amb/protocol";
import { CiResult, CiTarget } from "../ci-schema.js";

export const watchCiTool: ToolDefinition<CiTarget, CiResult> = {
  manifest: {
    name: "watch_ci",
    version: "1",
    description:
      "Watch a GitHub Actions run using authenticated gh. Wait internally without repeated calls. Return on first new failure for diagnosis while monitoring remaining jobs, or when the run finishes. Steering interrupts only the wait. Reuse repo/runId to continue watching.",
    effects: ["read", "network"],
    idempotency: "non-idempotent",
    parallelSafe: true,
    resumability: "inspect",
    timeoutPolicy: { idleMs: 60_000 },
  },
  inputSchema: CiTarget,
  outputSchema: CiResult,
  async execute(input, ctx) {
    if (!ctx.ciWatches) throw new Error("CI monitoring is unavailable in this session");
    return CiResult.parse(
      await ctx.ciWatches.wait(input, {
        signal: ctx.signal,
        wakeSignal: ctx.waitSignal,
        progress: (summary, active) => {
          if (ctx.scope)
            ctx.emit({
              schemaVersion: 1,
              kind: "ci.progress",
              sessionId: ctx.scope.sessionId,
              repo: input.repo,
              runId: input.runId,
              summary,
              active,
            });
        },
      }),
    );
  },
};
