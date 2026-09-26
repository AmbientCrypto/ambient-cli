import { describe, expect, it } from "vitest";
import { looksLikeSlashCommand } from "../src/tui/App.js";
import { SLASH_COMMANDS } from "../src/tui/components/SlashPalette.js";

describe("slash command detection", () => {
  it("a prompt that starts with a path is a task, not an unknown command", () => {
    expect(looksLikeSlashCommand("/Users/me/app.ts is broken")).toBe(false);
    expect(looksLikeSlashCommand("/tmp/log.txt — why does this fail?")).toBe(false);
  });
  it("a command-shaped first word is a command (known or a typo)", () => {
    expect(looksLikeSlashCommand("/modle")).toBe(true);
    expect(looksLikeSlashCommand("/goal ship it")).toBe(true);
    expect(looksLikeSlashCommand("/frontend:review now")).toBe(true);
  });
});

describe("palette", () => {
  it("offers the real effort tiers", () => {
    expect(SLASH_COMMANDS.find((c) => c.name === "/effort")?.args).toBe("[auto|off|high|max]");
  });
});

describe("single-segment paths", () => {
  it("'/tmp is full' is a task when /tmp exists; an unknown /word is still a command", () => {
    const exists = (p: string) => p === "/tmp" || p === "/README.md";
    expect(looksLikeSlashCommand("/tmp is full", exists)).toBe(false);
    expect(looksLikeSlashCommand("/README.md is wrong", exists)).toBe(false);
    expect(looksLikeSlashCommand("/modle", exists)).toBe(true);
  });
});
