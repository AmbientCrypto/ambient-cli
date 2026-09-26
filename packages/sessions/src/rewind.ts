import { posix } from "node:path";
import type { Event } from "@amb/protocol";

/**
 * Pure planning for `amb rewind`: given a session's durable events, compute how to revert the workspace to
 * the state BEFORE the last N mutation-turns. A "mutation-turn" is a turn that changed at least one file
 * (a pure Q&A turn is not counted). For each file touched in the undone window we restore it to the
 * pre-image of its EARLIEST mutation there (its content at the window boundary); a file first CREATED in the
 * window is deleted; a modify/delete whose pre-image was never checkpointed is UNRESTORABLE (never deleted).
 *
 * Purely a plan — the caller reads the blobs + touches the filesystem, and MUST conflict-check the current
 * content against `expectedNowHash` before applying (so a user's post-session edits are not silently lost).
 */
export type RewindAction = "restore" | "delete" | "unrestorable";
export interface RewindRestore {
  /** Canonical workspace-relative path (aliases like `./a.txt` and `a.txt` collapse to one). */
  path: string;
  action: RewindAction;
  /** For `restore`: the `sha256:<hex>` pre-image blob to write. */
  hashKey?: string;
  /** What the file's content hash SHOULD be right now if untouched since the session (postimage of its last
   *  mutation), or "absent" if its last mutation deleted it. undefined ⇒ unknown, skip the conflict check. */
  expectedNowHash?: string | "absent";
}
export interface RewindPlan {
  undoneTurnCount: number;
  restores: RewindRestore[];
}

interface Mutation {
  turnId: string;
  seq: number;
  path: string;
  operation: "create" | "modify" | "delete";
  preimageHash?: string;
  postimageHash?: string;
}

/**
 * Collapse path aliases (`./a`, `a//b`, `a/../b`) to one canonical identity via posix normalization. We do
 * NOT reinterpret backslashes as separators — on POSIX `a\b` is a real single-segment filename distinct from
 * `a/b`, and treating them as the same would delete the wrong file. Trailing `/` is trimmed.
 */
export function canonicalRel(p: string): string {
  const n = posix.normalize(p);
  return n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n;
}

function mutationsInOrder(events: Event[]): Mutation[] {
  return events
    .filter((e): e is Extract<Event, { kind: "file.mutation" }> => e.kind === "file.mutation")
    .map((e) => ({
      turnId: e.turnId,
      seq: e.seq,
      path: canonicalRel(e.path),
      operation: e.operation,
      preimageHash: e.preimageHash,
      postimageHash: e.postimageHash,
    }))
    .sort((a, b) => a.seq - b.seq);
}

/** Plan a rewind of the last `turns` mutation-turns (default 1 = undo the last file-changing turn). */
export function planRewind(events: Event[], turns = 1): RewindPlan {
  const muts = mutationsInOrder(events);
  const turnOrder: string[] = [];
  for (const m of muts) if (!turnOrder.includes(m.turnId)) turnOrder.push(m.turnId);
  const undone = turnOrder.slice(-Math.max(1, Math.floor(turns)));
  const undoneSet = new Set(undone);

  // The EARLIEST mutation per path within the undone window carries the file's boundary content; the LAST
  // mutation ANYWHERE in the session carries what the file should look like now (for the conflict check).
  const earliestInWindow = new Map<string, Mutation>();
  const lastEver = new Map<string, Mutation>();
  for (const m of muts) {
    lastEver.set(m.path, m);
    if (undoneSet.has(m.turnId) && !earliestInWindow.has(m.path)) earliestInWindow.set(m.path, m);
  }

  const restores: RewindRestore[] = [...earliestInWindow.entries()].map(([path, m]) => {
    const last = lastEver.get(path);
    const expectedNowHash: string | "absent" | undefined =
      last?.operation === "delete" ? "absent" : last?.postimageHash;
    if (m.operation === "create") return { path, action: "delete", expectedNowHash };
    if (m.preimageHash === undefined) return { path, action: "unrestorable", expectedNowHash };
    return { path, action: "restore", hashKey: m.preimageHash, expectedNowHash };
  });
  return { undoneTurnCount: undone.length, restores };
}
