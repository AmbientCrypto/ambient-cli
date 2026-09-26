import { describe, expect, it } from "vitest";
import {
  type GitHubStatus,
  type Runner,
  githubStatus,
  githubSummary,
} from "../src/agent/github.js";

// githubStatus shells out to `gh`; we inject a stub runner so these tests are hermetic + fast.
const NO_GH: Runner = () => undefined; // gh not installed, no output
const ghSignedIn =
  (account: string): Runner =>
  (cmd, args) =>
    args[0] === "--version"
      ? "gh version 2.40.0 (2026-01-01)"
      : args[0] === "auth"
        ? `github.com\n  ✓ Logged in to github.com account ${account} (keyring)`
        : undefined;
const ghSignedOut: Runner = (_cmd, args) =>
  args[0] === "--version" ? "gh version 2.40.0" : "You are not logged into any GitHub hosts.";

describe("githubStatus — token env is recognized", () => {
  it("treats GH_TOKEN as authed even without gh installed", () => {
    const s = githubStatus({ GH_TOKEN: "x" }, NO_GH);
    expect(s.authed).toBe(true);
    expect(s.ghInstalled).toBe(false);
    expect(s.tokenEnv).toBe("GH_TOKEN");
  });
  it("prefers GH_TOKEN over GITHUB_TOKEN", () => {
    expect(githubStatus({ GH_TOKEN: "x", GITHUB_TOKEN: "y" }, NO_GH).tokenEnv).toBe("GH_TOKEN");
    expect(githubStatus({ GITHUB_TOKEN: "y" }, NO_GH).tokenEnv).toBe("GITHUB_TOKEN");
  });
  it("ignores empty/whitespace token values", () => {
    expect(githubStatus({ GH_TOKEN: "   ", GITHUB_TOKEN: "" }, NO_GH).tokenEnv).toBeUndefined();
  });
});

describe("githubStatus — gh CLI parsing", () => {
  it("parses the signed-in account from `gh auth status`", () => {
    const s = githubStatus({}, ghSignedIn("octocat"));
    expect(s).toMatchObject({ ghInstalled: true, authed: true, account: "octocat" });
  });
  it("reports gh installed but not signed in", () => {
    const s = githubStatus({}, ghSignedOut);
    expect(s).toMatchObject({ ghInstalled: true, authed: false });
    expect(s.account).toBeUndefined();
  });
  it("a token env authenticates even when gh reports signed-out", () => {
    expect(githubStatus({ GITHUB_TOKEN: "t" }, ghSignedOut).authed).toBe(true);
  });
});

describe("githubSummary — human one-liner for every state", () => {
  const cases: Array<[GitHubStatus, string]> = [
    [{ ghInstalled: true, authed: true, account: "octocat" }, "signed in as octocat"],
    [{ ghInstalled: true, authed: true, account: "octocat", tokenEnv: "GH_TOKEN" }, "(GH_TOKEN)"],
    [{ ghInstalled: false, authed: true, tokenEnv: "GITHUB_TOKEN" }, "signed in"],
    [{ ghInstalled: true, authed: false }, "not signed in — run `ambient github login`"],
    [{ ghInstalled: false, authed: false }, "gh CLI not installed"],
  ];
  for (const [status, needle] of cases) {
    it(`contains "${needle}"`, () => {
      expect(githubSummary(status)).toContain(needle);
    });
  }
});
