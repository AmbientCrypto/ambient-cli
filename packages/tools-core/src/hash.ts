import { createHash } from "node:crypto";

/** Content hash used for file preimage/postimage tracking (conflict-safe edits + resume reconciliation). */
export function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}
