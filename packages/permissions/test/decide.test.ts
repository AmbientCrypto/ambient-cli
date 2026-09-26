import type { Effect, Mode, PermissionInput } from "@amb/protocol";
import { describe, expect, it } from "vitest";
import { decide } from "../src/index.js";

const input = (
  mode: Mode,
  effects: Effect[],
  over: Partial<PermissionInput> = {},
): PermissionInput => ({
  principal: "model",
  mode,
  toolName: "edit",
  effects,
  normalizedArgs: {},
  resolvedResources: ["/ws/a.ts"],
  workspaceRoot: "/ws",
  grants: [],
  ...over,
});

describe("decide — read-only", () => {
  it("allows read-only in every mode", () => {
    for (const mode of ["plan", "ask", "accept-edits", "bypass"] as Mode[]) {
      expect(decide(input(mode, ["read"], { toolName: "read" })).effect).toBe("allow");
    }
  });
});

describe("decide — no effects", () => {
  it("allows a zero-effect tool (e.g. ask_user) in EVERY mode — there's nothing to gate", () => {
    for (const mode of ["plan", "ask", "accept-edits", "bypass"] as Mode[]) {
      const d = decide(input(mode, [], { toolName: "ask_user", resolvedResources: [] }));
      expect(d.effect).toBe("allow"); // asking the human a question is not a side effect
    }
  });
});

describe("decide — mode ladder", () => {
  it("plan denies a write", () => {
    expect(decide(input("plan", ["write"])).effect).toBe("deny");
  });
  it("plan denies network egress too (read-only: touches nothing AND transmits nothing)", () => {
    expect(
      decide(input("plan", ["network"], { toolName: "web_fetch", resolvedResources: [] })).effect,
    ).toBe("deny");
  });
  it("ask asks for a write", () => {
    expect(decide(input("ask", ["write"])).effect).toBe("ask");
  });
  it("accept-edits auto-approves a file edit but gates shell", () => {
    expect(decide(input("accept-edits", ["write"])).effect).toBe("allow");
    expect(
      decide(input("accept-edits", ["process"], { toolName: "bash", resolvedResources: [] }))
        .effect,
    ).toBe("ask");
  });
  it("bypass allows everything (incl. outside workspace)", () => {
    expect(
      decide(input("bypass", ["process"], { toolName: "bash", resolvedResources: [] })).effect,
    ).toBe("allow");
    expect(decide(input("bypass", ["write"], { resolvedResources: ["/etc/hosts"] })).effect).toBe(
      "allow",
    );
  });
});

describe("decide — hard refusal (workspace boundary)", () => {
  it("denies write outside the workspace in ask mode", () => {
    expect(decide(input("ask", ["write"], { resolvedResources: ["/etc/passwd"] })).effect).toBe(
      "deny",
    );
  });
  it("asks for an in-workspace write", () => {
    expect(decide(input("ask", ["write"], { resolvedResources: ["/ws/sub/b.ts"] })).effect).toBe(
      "ask",
    );
  });
});

describe("decide — grants (model cannot self-grant)", () => {
  it("a session grant for the tool allows without asking", () => {
    const d = decide(input("ask", ["write"], { grants: [{ scope: "session", toolName: "edit" }] }));
    expect(d.effect).toBe("allow");
    expect(d.grantScope).toBe("session");
  });
  it("a resource grant only matches its granted resource", () => {
    expect(
      decide(
        input("ask", ["write"], {
          grants: [{ scope: "resource", toolName: "edit", resource: "/ws/other.ts" }],
        }),
      ).effect,
    ).toBe("ask");
    expect(
      decide(
        input("ask", ["write"], {
          resolvedResources: ["/ws/a.ts"],
          grants: [{ scope: "resource", toolName: "edit", resource: "/ws/a.ts" }],
        }),
      ).effect,
    ).toBe("allow");
  });
  it("ignores a grant for a different tool", () => {
    expect(
      decide(input("ask", ["write"], { grants: [{ scope: "session", toolName: "other" }] })).effect,
    ).toBe("ask");
  });
});
