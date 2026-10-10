import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NewEvent } from "@amb/protocol";
import type { SessionWriter } from "@amb/sessions";
import { afterEach, expect, it, vi } from "vitest";
import { SessionLifecycle } from "../src/tui/session-lifecycle.js";

let scratch: string | undefined;
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

it("records intentional closes once and leaves abnormal exits unmarked", () => {
  const append = vi.fn((_event: NewEvent) => null);
  const lifecycle = new SessionLifecycle("unused");
  lifecycle.close("quit");
  lifecycle.attach({ append } as unknown as SessionWriter, "ses_first");
  expect(append).not.toHaveBeenCalled();
  lifecycle.close("signal");
  lifecycle.close("quit");
  expect(append).toHaveBeenCalledTimes(1);
  expect(append).toHaveBeenCalledWith({
    schemaVersion: 1,
    kind: "session.closed",
    sessionId: "ses_first",
    reason: "signal",
  });
  lifecycle.attach({ append } as unknown as SessionWriter, "ses_second");
  lifecycle.close("quit");
  expect(append).toHaveBeenCalledTimes(2);
});

it("remembers a declined offer without hiding newer interrupted work", () => {
  scratch = mkdtempSync(join(tmpdir(), "ambient-recovery-choice-"));
  const lifecycle = new SessionLifecycle(scratch);
  const recovery = { fromSessionId: "ses_first", priorLastEventId: "evt_first" };
  expect(lifecycle.dismissed(recovery)).toBe(false);
  lifecycle.dismiss(recovery);
  expect(new SessionLifecycle(scratch).dismissed(recovery)).toBe(true);
  expect(lifecycle.dismissed({ ...recovery, priorLastEventId: "evt_new" })).toBe(false);
  expect(lifecycle.dismissed({ ...recovery, fromSessionId: "ses_other" })).toBe(false);
  lifecycle.dismiss({ fromSessionId: "ses_other", priorLastEventId: "evt_other" });
  expect(lifecycle.dismissed(recovery)).toBe(true);
});

it("surfaces close failures so they cannot silently suppress crash recovery", () => {
  const append = vi.fn(() => {
    throw new Error("disk full");
  });
  const lifecycle = new SessionLifecycle("unused");
  lifecycle.attach({ append } as unknown as SessionWriter, "ses_first");
  expect(() => lifecycle.close("quit")).toThrow("disk full");
  expect(() => lifecycle.close("quit")).toThrow("disk full");
});

it("rejects damaged or oversized recovery choices", () => {
  scratch = mkdtempSync(join(tmpdir(), "ambient-recovery-choice-"));
  const lifecycle = new SessionLifecycle(scratch);
  const recovery = { fromSessionId: "ses_first" };
  lifecycle.dismiss(recovery);
  const path = join(scratch, "recovery-choices", "ses_first.json");
  writeFileSync(path, "invalid JSON");
  expect(() => lifecycle.dismissed(recovery)).toThrow();
  writeFileSync(path, "x".repeat(1025));
  expect(() => lifecycle.dismissed(recovery)).toThrow("safe size");
});

it("rejects recovery identifiers that could escape private storage", () => {
  const lifecycle = new SessionLifecycle("unused");
  expect(() => lifecycle.dismiss({ fromSessionId: "../outside" })).toThrow();
  expect(() => lifecycle.dismissed({ fromSessionId: "../outside" })).toThrow();
});
