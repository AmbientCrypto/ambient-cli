import { describe, expect, it } from "vitest";
import { PromptQueue } from "../src/tui/prompt-queue.js";

describe("PromptQueue", () => {
  it("shows one prompt at a time; the second waits for the first answer", async () => {
    const q = new PromptQueue();
    const answers: Array<(v: string) => void> = [];
    let open = 0;
    let most = 0;
    const show = () =>
      new Promise<string>((resolve) => {
        open++;
        most = Math.max(most, open);
        answers.push((v) => {
          open--;
          resolve(v);
        });
      });
    const a = q.run(show, "deny");
    const b = q.run(show, "deny");
    await Promise.resolve();
    await Promise.resolve();
    expect(answers).toHaveLength(1);
    answers[0]?.("allow");
    expect(await a).toBe("allow");
    await Promise.resolve();
    answers[1]?.("allow-2");
    expect(await b).toBe("allow-2");
    expect(most).toBe(1);
  });
  it("prompts still waiting when the run ends settle with their fallback, unseen", async () => {
    const q = new PromptQueue();
    let shown = 0;
    let answerFirst: (v: string) => void = () => {};
    const first = q.run(
      () =>
        new Promise<string>((r) => {
          shown++;
          answerFirst = r;
        }),
      "deny",
    );
    const second = q.run(async () => {
      shown++;
      return "allow";
    }, "deny");
    await Promise.resolve();
    q.settleWaiting();
    answerFirst("deny"); // the open one is settled by the caller (Esc / run end)
    expect(await first).toBe("deny");
    expect(await second).toBe("deny");
    expect(shown).toBe(1);
  });
});
