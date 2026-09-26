import type { ImageAttachment } from "@amb/protocol";
import type { Key } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyCandidate, KeySource } from "../secrets.js";
import {
  type KeyCheckResult,
  type KeyPromptReason,
  type KeyPromptState,
  keyPromptInput,
  keyPromptSettled,
  openKeyPrompt,
} from "./key-flow.js";
import type { StartupKeyResult } from "./startup-key.js";

/** The account effects the App needs — implemented at the CLI edge (keychain/network), never in the App. */
export interface AccountPort {
  keysUrl: string;
  /** Check a key with Ambient (free — no model runs). */
  verify(key: string): Promise<KeyCheckResult>;
  /** Save the key and switch the live client to it. Throws a secret-free error on failure. */
  save(key: string): void;
  /** Remove the saved key from this machine; returns what to tell the user (e.g. which key is still in use). */
  remove(): string;
  /** Open the keys page in the browser; false when it couldn't launch. */
  openKeysPage(): boolean;
  /** Masked form of a key for confirmations (`…1234`). */
  mask(key: string): string;
  /** The launch-time check of the key in use (resolved in the background; it reports, never switches). */
  startupCheck?: Promise<StartupKeyResult>;
  /** Switch the live session to a key already stored on this machine (no save). */
  useKey(key: string): void;
  /** Human wording for where a key came from. */
  sourceLabel(source: KeySource): string;
  /** AMBIENT_API_KEY is set: it takes priority over any saved key on the next launch. */
  envKeyOverrides?: boolean;
}

type Notice = (level: "info" | "warn" | "error", text: string) => void;

/**
 * The in-app key flow: opens the KeyPrompt panel (a rejected key mid-run, a saved key that fails the startup
 * check, or /login), owns its keystrokes while open, checks + saves the new key, and re-runs the task that
 * failed on the old one. Returns the panel state plus the entry points the App wires into its router.
 */
export function useKeyPrompt(
  account: AccountPort | undefined,
  notice: Notice,
  rerun: (text: string, attachments: ImageAttachment[]) => void,
  isBusy: () => boolean,
) {
  const [state, setStateRaw] = useState<KeyPromptState | null>(null);
  const ref = useRef<KeyPromptState | null>(null);
  // Bumped whenever the panel opens or closes: a key check that finishes after the user moved on (Esc, or a
  // new /login) is stale and must not save anything or reopen anything.
  const generation = useRef(0);
  // Set once a key is saved this session: a slow launch check of the OLD key must never override or complain.
  const savedThisSession = useRef(false);
  // Set when the launch check switched to another working key: a run that was already in flight on the old key
  // and fails with "rejected" is then simply retried instead of asking the user for a key.
  const switchedKey = useRef(false);
  const setState = useCallback((s: KeyPromptState | null, bump = false) => {
    if (bump) generation.current += 1;
    ref.current = s;
    setStateRaw(s);
  }, []);

  const open = useCallback(
    (reason: KeyPromptReason, retry?: { text: string; attachments: ImageAttachment[] }) => {
      if (!account) return;
      if (reason === "rejected" && switchedKey.current && retry) {
        switchedKey.current = false;
        notice("info", "Retrying with the working key…");
        rerun(retry.text, retry.attachments);
        return;
      }
      setState(openKeyPrompt(reason, retry), true);
    },
    [account, notice, rerun, setState],
  );

  // A saved key that no longer works is caught at launch, before the user types anything.
  useEffect(() => {
    let live = true;
    void account?.startupCheck?.then(({ result, alternative, rejected }) => {
      // A key the user saved meanwhile always wins over what the launch check found.
      if (!live || savedThisSession.current || !account) return;
      if (alternative) {
        switchedKey.current = true;
        notice("info", adoptWorkingKey(account, alternative, rejected));
        // A key panel opened by a run that already failed on the old key → retry it with the working one.
        const openPanel = ref.current;
        if (openPanel && openPanel.reason !== "change") {
          setState(null, true);
          switchedKey.current = false;
          if (openPanel.retry) rerun(openPanel.retry.text, openPanel.retry.attachments);
        }
        return;
      }
      // A run in flight will surface a rejected key itself (and retry after it's fixed) — never pop the panel
      // over it or over another open panel.
      if (result === "invalid" && !ref.current && !isBusy()) {
        setState(openKeyPrompt("invalid-at-start"), true);
      }
    });
    return () => {
      live = false;
    };
  }, [account, isBusy, notice, rerun, setState]);

  const submit = useCallback(async () => {
    const s = ref.current;
    if (!account || !s || s.status === "checking" || s.value.length === 0) return;
    const key = s.value;
    const gen = generation.current;
    setState({ ...s, status: "checking" });
    const result = await account.verify(key);
    if (gen !== generation.current) return; // the user dismissed or reopened the panel meanwhile
    const next = keyPromptSettled(s, result);
    if (next) {
      setState(next);
      return;
    }
    try {
      account.save(key);
    } catch (e) {
      setState({ ...s, status: "idle" });
      notice("error", `Could not save the key: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    savedThisSession.current = true;
    setState(null, true);
    if (account.envKeyOverrides) {
      notice(
        "warn",
        "AMBIENT_API_KEY is set in your shell and will override this saved key next time — update or unset it.",
      );
    }
    notice(
      "info",
      result === "valid"
        ? `✓ Signed in with key ${account.mask(key)}`
        : `✓ Saved key ${account.mask(key)} — couldn't reach Ambient to check it; it's used from your next request`,
    );
    if (s.retry) rerun(s.retry.text, s.retry.attachments);
  }, [account, notice, rerun, setState]);

  /** Route a keystroke while the panel is open. Returns true when it consumed the key. */
  const handleInput = useCallback(
    (ch: string, key: Key): boolean => {
      const s = ref.current;
      if (!s) return false;
      if (key.escape) {
        setState(null, true);
        notice(
          "info",
          s.retry
            ? "Key unchanged — your request didn't run. Type /login to add a working key."
            : "Key unchanged — type /login any time to switch keys.",
        );
        return true;
      }
      if (key.return) {
        void submit();
        return true;
      }
      if (key.ctrl && ch === "o") {
        if (account && !account.openKeysPage())
          notice("info", `Open ${account.keysUrl} in your browser.`);
        return true;
      }
      if (key.backspace || key.delete) {
        setState(keyPromptInput(s, { backspace: true }));
        return true;
      }
      if (!key.ctrl && !key.meta && ch.length > 0) setState(keyPromptInput(s, { text: ch }));
      return true; // the panel owns the keyboard while open
    },
    [account, notice, setState, submit],
  );

  return { state, isOpen: () => ref.current !== null, open, handleInput };
}

/**
 * Switch to a working key found on this machine after the one in use was rejected. When the rejected key was
 * ambient's own saved key, the working key replaces it, so there's one good key and this never comes up
 * again. A rejected AMBIENT_API_KEY is the user's to change — it's only worked around for this session.
 */
export function adoptWorkingKey(
  account: AccountPort,
  alternative: KeyCandidate,
  rejected: KeyCandidate["source"] | undefined,
): string {
  const masked = account.mask(alternative.key);
  if (rejected === "keychain" || rejected === "file") {
    try {
      account.save(alternative.key);
      return `Your saved Ambient key had stopped working. Replaced it with the working key ${masked} (${account.sourceLabel(alternative.source)}).`;
    } catch {
      // Saving failed (e.g. a locked keychain): still use the working key for this session.
    }
  }
  account.useKey(alternative.key);
  return rejected === "env"
    ? `AMBIENT_API_KEY was rejected, so this session uses ${masked} (${account.sourceLabel(alternative.source)}). Update or unset AMBIENT_API_KEY to fix it.`
    : `Your saved Ambient key was rejected, so this session uses ${masked} (${account.sourceLabel(alternative.source)}). /login saves a key.`;
}
