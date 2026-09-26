import { describe, expect, it } from "vitest";
import { SLASH_COMMANDS } from "../src/tui/components/SlashPalette.js";
import { helpText } from "../src/tui/help.js";

describe("/help", () => {
  it("lists every built-in command with what it does, the user's own as a count, and the keys", () => {
    const text = helpText(SLASH_COMMANDS, 42);
    for (const c of SLASH_COMMANDS) expect(text).toContain(c.name);
    expect(text).toContain("Switch model");
    expect(text).toContain("plus 42 of your own commands");
    expect(text).toContain("ctrl+r");
    expect(text).toContain("\\ then enter");
    // Two aligned columns: every command's description starts in the same column.
    const lines = text.split("\n");
    const cols = SLASH_COMMANDS.map((c) => {
      const line = lines.find((l) => l.startsWith(`  ${c.name}`)) ?? "";
      return line.indexOf(c.desc);
    });
    expect(Math.min(...cols)).toBeGreaterThan(0);
    expect(new Set(cols).size).toBe(1);
  });
});
