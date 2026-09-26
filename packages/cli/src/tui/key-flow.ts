import type { ImageAttachment } from "@amb/protocol";
import { normalizePastedText } from "./capture.js";

/**
 * The in-app "fix your API key" flow as a pure state machine (the App owns the keychain/network effects).
 * Opened when Ambient rejects the key mid-session (revoked or mistyped), when the startup check finds the
 * saved key doesn't work, or by `/login` to switch keys. A task that failed on the bad key can ride along
 * and be retried the moment a working key is saved.
 */

export type KeyPromptReason = "rejected" | "invalid-at-start" | "change";
export type KeyCheckResult = "valid" | "invalid" | "unknown";

export interface KeyPromptState {
  reason: KeyPromptReason;
  /** The key as typed/pasted — only ever rendered masked. */
  value: string;
  status: "idle" | "checking" | "rejected";
  /** The task to re-run once a working key is saved. */
  retry?: { text: string; attachments: ImageAttachment[] };
}

export function openKeyPrompt(
  reason: KeyPromptReason,
  retry?: { text: string; attachments: ImageAttachment[] },
): KeyPromptState {
  return { reason, value: "", status: "idle", ...(retry ? { retry } : {}) };
}

/** Apply a keystroke or paste. A key is one token, so whitespace (incl. pasted newlines) is dropped. */
export function keyPromptInput(
  s: KeyPromptState,
  input: { text?: string; backspace?: boolean },
): KeyPromptState {
  if (s.status === "checking") return s;
  if (input.backspace) return { ...s, value: s.value.slice(0, -1), status: "idle" };
  const add = normalizePastedText(input.text ?? "").replace(/\s+/g, "");
  if (!add) return s;
  return { ...s, value: s.value + add, status: "idle" };
}

/** Fold the result of checking the key: rejected → stay open (cleared for a fresh paste); otherwise close. */
export function keyPromptSettled(s: KeyPromptState, result: KeyCheckResult): KeyPromptState | null {
  if (result === "invalid") return { ...s, value: "", status: "rejected" };
  return null;
}
