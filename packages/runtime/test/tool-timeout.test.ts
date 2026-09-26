import type { ToolDefinition } from "@amb/protocol";
import { describe, expect, it } from "vitest";
import { runBounded } from "../src/execute-tools.js";

const tool = (effects: string[], stopsAfterMs: number, onStop: () => void): ToolDefinition =>
  ({
    manifest: { name: "slow", effects, timeoutPolicy: { maximumMs: 30 } },
    execute: (_args: unknown, ctx: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        ctx.signal.addEventListener("abort", () =>
          setTimeout(() => {
            onStop();
            reject(new Error("stopped"));
          }, stopsAfterMs),
        );
      }),
  }) as unknown as ToolDefinition;

describe("a tool that runs past its time limit", () => {
  it("that changes files is reported only once it has stopped", async () => {
    let stopped = false;
    await expect(
      runBounded(
        tool(["write"], 150, () => {
          stopped = true;
        }),
        {},
        {} as never,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/exceeded its 30ms limit/);
    expect(stopped).toBe(true);
  });

  it("that only reads is reported at once", async () => {
    let stopped = false;
    await expect(
      runBounded(
        tool(["read"], 150, () => {
          stopped = true;
        }),
        {},
        {} as never,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/exceeded/);
    expect(stopped).toBe(false);
  });
});
