import { describe, expect, it } from "vitest";
import { keyPromptInput, keyPromptSettled, openKeyPrompt } from "../src/tui/key-flow.js";

describe("key prompt state", () => {
  it("opens with the reason and an optional task to retry once the key works", () => {
    const s = openKeyPrompt("rejected", { text: "fix the bug", attachments: [] });
    expect(s).toMatchObject({ reason: "rejected", value: "", status: "idle" });
    expect(s.retry?.text).toBe("fix the bug");
  });

  it("typing/pasting appends cleaned text (paste markers, spaces and newlines dropped); backspace deletes", () => {
    let s = openKeyPrompt("change");
    s = keyPromptInput(s, { text: "\x1b[200~sk-abc 123\n\x1b[201~" });
    expect(s.value).toBe("sk-abc123");
    s = keyPromptInput(s, { backspace: true });
    expect(s.value).toBe("sk-abc12");
  });

  it("input after a rejection starts a fresh attempt (the status clears)", () => {
    const rejected = keyPromptSettled(
      { ...openKeyPrompt("change"), status: "checking", value: "x" },
      "invalid",
    );
    if (!rejected) throw new Error("expected the prompt to stay open");
    expect(rejected.status).toBe("rejected");
    expect(rejected.value).toBe(""); // cleared so the next paste isn't appended to the bad key
    expect(keyPromptInput(rejected, { text: "y" }).status).toBe("idle");
  });

  it("a valid or unverifiable key closes the prompt (null)", () => {
    const checking = { ...openKeyPrompt("rejected"), status: "checking" as const, value: "k" };
    expect(keyPromptSettled(checking, "valid")).toBeNull();
    expect(keyPromptSettled(checking, "unknown")).toBeNull();
  });
});

describe("KeyPrompt panel", () => {
  it("never shows the key — only a masked length — and says what to do", async () => {
    const { render } = await import("ink-testing-library");
    const { createElement } = await import("react");
    const { KeyPrompt } = await import("../src/tui/components/KeyPrompt.js");
    const state = { ...openKeyPrompt("rejected"), value: "sk-supersecret-9876" };
    const { lastFrame, unmount } = render(
      createElement(KeyPrompt, { state, width: 90, keysUrl: "https://app.ambient.xyz/keys" }),
    );
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("supersecret");
    expect(frame).toContain("19 chars");
    expect(frame).toContain("rejected your API key");
    expect(frame).toContain("app.ambient.xyz/keys");
    expect(frame).toContain("esc keep current key");
    unmount();
  });
});
