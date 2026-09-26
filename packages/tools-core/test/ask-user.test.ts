import type { AskRequest, AskResponse, ToolContext } from "@amb/protocol";
import { describe, expect, it } from "vitest";
import { askUserTool, formatAnswer } from "../src/tools/ask-user.js";

const baseCtx = (ask?: ToolContext["ask"]): ToolContext => ({
  cwd: "/w",
  workspaceRoot: "/w",
  signal: new AbortController().signal,
  secret: async () => "",
  emit: () => {},
  ...(ask ? { ask } : {}),
});

describe("ask_user tool", () => {
  it("routes the question to ctx.ask and formats the selection + notes", async () => {
    let seen: AskRequest | undefined;
    const ask = async (req: AskRequest): Promise<AskResponse> => {
      seen = req;
      return { selected: ["Web app"], text: "prefer React" };
    };
    const out = await askUserTool.execute(
      {
        question: "What platform?",
        options: [{ label: "Web app" }, { label: "iOS app" }],
      },
      baseCtx(ask),
    );
    expect(seen?.question).toBe("What platform?");
    expect(seen?.allowText).toBe(true); // defaults on
    expect(out.answered).toBe(true);
    expect(out.answer).toContain("Web app");
    expect(out.answer).toContain("prefer React");
  });

  it("returns a proceed-on-best-judgment note when NO interactive user is available (headless)", async () => {
    const out = await askUserTool.execute({ question: "Which approach?" }, baseCtx(/* no ask */));
    expect(out.answered).toBe(false);
    expect(out.answer.toLowerCase()).toContain("best judgment");
  });

  it("a cancelled (Esc) answer tells the agent to proceed", async () => {
    const ask = async (): Promise<AskResponse> => ({ selected: [], cancelled: true });
    const out = await askUserTool.execute({ question: "Ship it?" }, baseCtx(ask));
    expect(out.answered).toBe(false);
    expect(out.answer.toLowerCase()).toContain("proceed");
  });

  it("has no side effects and is never parallel-run (it's interactive)", () => {
    expect(askUserTool.manifest.effects).toEqual([]);
    expect(askUserTool.manifest.parallelSafe).toBe(false);
    // No maximumMs — an interactive answer can take as long as the human needs (only maximumMs is enforced).
    expect(askUserTool.manifest.timeoutPolicy.maximumMs).toBeUndefined();
  });

  it("formatAnswer joins selection + notes, and handles empty answers", () => {
    const req: AskRequest = { question: "q" };
    expect(formatAnswer(req, { selected: ["A", "B"], text: "extra" })).toBe(
      "Selected: A, B. Notes: extra",
    );
    expect(formatAnswer(req, { selected: [] }).toLowerCase()).toContain("best judgment");
    expect(formatAnswer(req, { selected: [], cancelled: true }).toLowerCase()).toContain("proceed");
  });
});
