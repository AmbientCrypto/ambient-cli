import { describe, expect, it } from "vitest";
import { cleanSecretInput } from "../src/terminal/read-secret.js";

describe("cleanSecretInput", () => {
  it("strips bracketed-paste markers and other escape sequences from a pasted key", () => {
    expect(cleanSecretInput("\x1b[200~sk-abc123\x1b[201~")).toBe("sk-abc123");
    expect(cleanSecretInput("[200~sk-abc123[201~")).toBe("sk-abc123"); // ESC already dropped by the terminal
  });
  it("trims surrounding whitespace", () => {
    expect(cleanSecretInput("  sk-abc  ")).toBe("sk-abc");
  });
});
