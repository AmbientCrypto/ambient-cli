import { expect, it } from "vitest";
import { assertQueueCapacity } from "../src/tui/queued-messages.js";

it("refuses oversized queues without discarding existing messages", () => {
  const existing = Array.from({ length: 64 }, () => ({ text: "keep" }));
  expect(() => assertQueueCapacity(existing, "new", [])).toThrow(/full/);
  expect(existing).toHaveLength(64);
  expect(() => assertQueueCapacity([], "x".repeat(8 * 1024 * 1024 + 1), [])).toThrow(/size/);
  expect(() => assertQueueCapacity([{ text: "keep" }], "new", [])).not.toThrow();
});

it("reports a persistence failure without acknowledging a message", async () => {
  const { acceptQueuedMessage } = await import("../src/tui/queued-messages.js");
  const writer = {
    append() {
      throw Error("disk full");
    },
  };
  expect(() => acceptQueuedMessage(writer as never, "ses_test", "keep in composer", [])).toThrow(
    "disk full",
  );
});
it("restores undelivered images and refuses a damaged blob", async () => {
  const { createHash } = await import("node:crypto");
  const { mkdtempSync, rmSync, readdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { SessionWriter, readSession, objectsDir } = await import("@amb/sessions");
  const { newSessionId, newTurnId } = await import("@amb/protocol");
  const { acceptQueuedMessage } = await import("../src/tui/queued-messages.js");
  const { recoverMessages } = await import("../src/agent/recovered-messages.js");
  const scratch = mkdtempSync(join(tmpdir(), "ambient-queued-image-"));
  const previous = process.env.AMB_HOME;
  process.env.AMB_HOME = scratch;
  try {
    const id = newSessionId();
    const turnId = newTurnId();
    const writer = new SessionWriter(id, () => new Date().toISOString());
    const bytes = Buffer.from("small image fixture");
    const image = {
      id: "image",
      mediaType: "image/png" as const,
      dataBase64: bytes.toString("base64"),
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      source: "file" as const,
    };
    const message = acceptQueuedMessage(writer, id, "check image", [image]);
    expect(recoverMessages(id, readSession(id).events)[0]?.attachments).toEqual([image]);
    const files = readdirSync(objectsDir(id));
    rmSync(join(objectsDir(id), files[0] as string));
    expect(() => recoverMessages(id, readSession(id).events)).toThrow(/missing or damaged/);
    writer.append({ schemaVersion: 1, kind: "steer", sessionId: id, turnId, ...message });
    expect(recoverMessages(id, readSession(id).events)).toEqual([]);
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "AMB_HOME");
    else process.env.AMB_HOME = previous;
    rmSync(scratch, { recursive: true, force: true });
  }
});
