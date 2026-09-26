import { describe, expect, it } from "vitest";
import { commandHelp, wantsCommandHelp } from "../src/help.js";

describe("help for one command", () => {
  it("--help after a command shows help instead of running it", () => {
    expect(wantsCommandHelp("logout", ["--help"])).toBe(true);
    expect(wantsCommandHelp("trust", ["yes", "-h"])).toBe(true);
    expect(wantsCommandHelp("run", ["--help"])).toBe(false); // run prints its own usage
    expect(wantsCommandHelp("logout", [])).toBe(false);
  });
  it("shows the command's line, and its flags when it has a section", () => {
    expect(commandHelp("logout")).toContain("ambient logout");
    expect(commandHelp("logout")).not.toContain("ambient login ");
    expect(commandHelp("eval")).toContain("--save-baseline");
    expect(commandHelp("gh")).toContain("ambient github");
    expect(commandHelp("nope")).toContain("Usage:");
  });
});
