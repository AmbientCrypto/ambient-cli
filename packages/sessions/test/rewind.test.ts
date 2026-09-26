import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event } from "@amb/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contentHash, objectsDir, planRewind, readObject, saveObject } from "../src/index.js";

let env: Record<string, string | undefined>;
beforeEach(async () => {
  env = { AMB_HOME: await mkdtemp(join(tmpdir(), "amb-rw-")) };
});
afterEach(async () => {
  if (env.AMB_HOME) await rm(env.AMB_HOME, { recursive: true, force: true });
});

const SID = "ses_rw0001";

describe("object store (content-addressed blobs)", () => {
  it("saves a blob keyed by its content hash and reads it back; save is idempotent", () => {
    const key = saveObject(SID, "hello\n", env);
    expect(key).toBe(contentHash("hello\n"));
    expect(saveObject(SID, "hello\n", env)).toBe(key); // idempotent
    expect(readObject(SID, key, env)).toBe("hello\n");
    expect(readObject(SID, contentHash("never saved"), env)).toBeUndefined();
  });
  it("never returns a blob whose content no longer matches its hash, and a save repairs it", () => {
    const key = saveObject(SID, "the original file\n", env);
    const file = join(objectsDir(SID, env), key.slice("sha256:".length));
    writeFileSync(file, "the orig"); // torn / corrupted on disk
    expect(readObject(SID, key, env)).toBeUndefined();
    saveObject(SID, "the original file\n", env);
    expect(readObject(SID, key, env)).toBe("the original file\n");
  });
  it("rejects a malformed hash key", () => {
    expect(() => readObject(SID, "../etc/passwd", env)).not.toThrow(); // read swallows → undefined
    expect(readObject(SID, "../etc/passwd", env)).toBeUndefined();
  });
});

// Build a file.mutation event (only the fields planRewind reads matter).
const mut = (
  turnId: string,
  seq: number,
  path: string,
  operation: "create" | "modify" | "delete",
  preimageHash?: string,
  postimageHash?: string,
): Event =>
  ({
    schemaVersion: 1,
    kind: "file.mutation",
    eventId: `evt_${seq}`,
    sessionId: "ses_x",
    seq,
    ts: "2026-09-02T00:00:00.000Z",
    turnId,
    path,
    operation,
    ...(preimageHash ? { preimageHash } : {}),
    ...(postimageHash ? { postimageHash } : {}),
  }) as Event;

const byPath = (plan: { restores: { path: string }[] }) =>
  Object.fromEntries(plan.restores.map((r) => [r.path, r]));

describe("planRewind", () => {
  it("undoes the last mutation-turn: modify → restore preimage, create → delete", () => {
    const events: Event[] = [
      mut("trn_1", 5, "a.ts", "modify", contentHash("old a\n")),
      mut("trn_2", 9, "a.ts", "modify", contentHash("mid a\n"), contentHash("new a\n")),
      mut("trn_2", 10, "b.ts", "create", undefined, contentHash("b\n")),
    ];
    const plan = planRewind(events, 1); // undo turn 2 only
    expect(plan.undoneTurnCount).toBe(1);
    const m = byPath(plan);
    expect(m["a.ts"]).toMatchObject({ action: "restore", hashKey: contentHash("mid a\n") });
    expect(m["b.ts"]).toMatchObject({ action: "delete" }); // created in turn 2 → delete it
  });

  it("undoing MULTIPLE turns restores to the earliest preimage in the window", () => {
    const events: Event[] = [
      mut("trn_1", 5, "a.ts", "modify", contentHash("v0\n")),
      mut("trn_2", 9, "a.ts", "modify", contentHash("v1\n")),
      mut("trn_3", 12, "a.ts", "modify", contentHash("v2\n")),
    ];
    const plan = planRewind(events, 2); // undo turns 2 and 3
    expect(plan.undoneTurnCount).toBe(2);
    expect(plan.restores[0]).toMatchObject({ action: "restore", hashKey: contentHash("v1\n") });
  });

  it("collapses path aliases (`./a.ts` and `a.ts`) to ONE canonical file", () => {
    const events: Event[] = [
      mut("trn_2", 9, "a.ts", "modify", contentHash("boundary\n")),
      mut("trn_3", 12, "./a.ts", "modify", contentHash("later\n")),
    ];
    const plan = planRewind(events, 2);
    expect(plan.restores).toHaveLength(1);
    // The EARLIEST preimage in the window (turn 2's "boundary") wins, not turn 3's.
    expect(plan.restores[0]).toMatchObject({ path: "a.ts", hashKey: contentHash("boundary\n") });
  });

  it("a modify/delete with NO checkpointed preimage is UNRESTORABLE, never deleted", () => {
    const events: Event[] = [mut("trn_1", 5, "x.ts", "modify")]; // no preimageHash
    expect(planRewind(events, 1).restores[0]).toMatchObject({
      path: "x.ts",
      action: "unrestorable",
    });
  });

  it("carries the expected-now hash (postimage of the last mutation) for the conflict check", () => {
    const events: Event[] = [
      mut("trn_1", 5, "a.ts", "modify", contentHash("pre\n"), contentHash("post\n")),
    ];
    expect(planRewind(events, 1).restores[0]).toMatchObject({
      expectedNowHash: contentHash("post\n"),
    });
  });

  it("caps the window at the number of mutation-turns that exist", () => {
    const events: Event[] = [mut("trn_1", 5, "a.ts", "create")];
    expect(planRewind(events, 10).undoneTurnCount).toBe(1);
    expect(planRewind([], 1)).toEqual({ undoneTurnCount: 0, restores: [] });
  });

  it("ROUND TRIP: a checkpointed pre-image is recovered by the planned hashKey", () => {
    const pre = "the original content\n";
    const key = saveObject(SID, pre, env);
    const events: Event[] = [mut("trn_1", 5, "a.ts", "modify", contentHash(pre))];
    const plan = planRewind(events, 1);
    expect(plan.restores[0]).toMatchObject({ action: "restore", hashKey: key });
    expect(readObject(SID, plan.restores[0]?.hashKey as string, env)).toBe(pre);
  });
});
