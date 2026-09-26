import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeWorkspaceContextPort } from "../src/agent/workspace-context-port.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "amb-wsport-"));
  writeFileSync(join(dir, "a.ts"), "export function alpha() {}\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("repo map in the workspace port", () => {
  it("stays the same for a session even after files change (keeps the system prompt cacheable)", () => {
    const port = makeWorkspaceContextPort(undefined, { stableRepoMap: true });
    const first = port.repoMap?.(dir, 4_000);
    writeFileSync(join(dir, "b.ts"), "export function beta() {}\n");
    expect(port.repoMap?.(dir, 4_000)).toBe(first);
  });
  it("is rebuilt each call without the option (one-shot runs)", () => {
    const port = makeWorkspaceContextPort();
    const first = port.repoMap?.(dir, 4_000);
    writeFileSync(join(dir, "b.ts"), "export function beta() {}\n");
    expect(port.repoMap?.(dir, 4_000)).not.toBe(first);
  });
});
