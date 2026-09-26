import { describe, expect, it } from "vitest";
import { activeMention, insertMention } from "../src/tui/mention.js";

describe("@ file mentions", () => {
  it("finds the @word being typed at the cursor", () => {
    expect(activeMention("look at @src/ap", 15)).toEqual({ start: 8, query: "src/ap" });
    expect(activeMention("@", 1)).toEqual({ start: 0, query: "" });
  });
  it("ignores emails, finished words and a cursor inside a word", () => {
    expect(activeMention("mail me@host", 12)).toBeUndefined();
    expect(activeMention("look at @src/app.ts now", 23)).toBeUndefined();
    expect(activeMention("look at @src/app.ts", 12)).toBeUndefined();
  });
  it("replaces the mention with the chosen path and a trailing space", () => {
    const text = "look at @ap please";
    const m = activeMention(text, 11);
    expect(m).toBeDefined();
    expect(insertMention(text, 11, m as NonNullable<typeof m>, "src/app.ts")).toEqual({
      text: "look at @src/app.ts please",
      cursor: 20,
    });
  });
});
