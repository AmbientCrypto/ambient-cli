import { createInterface } from "node:readline/promises";
import type { Approver } from "@amb/runtime";
import { PREVIEW_MAX_CHARS, toolPreviewBody } from "../presentation/tool-preview.js";
import { add, bad, bold, dim } from "../render/color.js";

/** Effects that can never be workspace-bounded — always require an explicit prompt (never --yes auto). */
const UNBOUNDED = new Set(["process", "network", "secret"]);

const MAX_PREVIEW_LINES = 20;

/** Char-bound a single value with an honest generic truncation marker (shared cap with the modal). */
function clip(s: string): { text: string; truncated: boolean } {
  return s.length > PREVIEW_MAX_CHARS
    ? { text: s.slice(0, PREVIEW_MAX_CHARS), truncated: true }
    : { text: s, truncated: false };
}

/**
 * Build a bounded change preview from a tool's INPUT args (approval happens BEFORE execution, so no diff
 * exists yet): `bash` shows its command; `write`/`edit`/`diff` share the SAME body builder as the Ink modal
 * (toolPreviewBody), so the two surfaces never disagree on what's being approved. Returns colored stderr lines.
 */
function previewFor(args: unknown): string[] {
  const a = args as Record<string, unknown> | undefined;
  const path = typeof a?.path === "string" ? a.path : undefined;
  const pathLine = path ? [dim(`  ${path}`)] : [];
  const trunc = [dim("  … (truncated)")];

  if (typeof a?.command === "string") {
    const c = clip(a.command);
    return [`  $ ${c.text}`, ...(c.truncated ? trunc : [])];
  }

  const body = toolPreviewBody(a, MAX_PREVIEW_LINES);
  if (body.lines.length > 0) {
    const colored = body.lines.map((l) =>
      l.kind === "add"
        ? add(`  ${l.text}`)
        : l.kind === "del"
          ? bad(`  ${l.text}`)
          : dim(`  ${l.text}`),
    );
    return [...pathLine, ...colored, ...(body.charTruncated || body.hidden > 0 ? trunc : [])];
  }

  if (path) return pathLine;
  const c = clip(JSON.stringify(a ?? {}));
  return [dim(`  ${c.text}`), ...(c.truncated ? trunc : [])];
}

/**
 * Interactive approver for Ask mode. Shows the tool + a diff/command preview and asks the user
 * to allow/deny. Non-interactive (no TTY): deny by default (safe).
 *
 * `--yes` (autoAllow) auto-approves file edits/reads, but NOT shell/network — those are unbounded and
 * always require an explicit prompt (or deny with no TTY). Full `--bypass` is the way to auto-run shell.
 */
export function makeInteractiveApprover(opts: {
  autoAllow: boolean;
  /** False for print mode: never prompt, even in a terminal. */
  interactive?: boolean;
}): Approver {
  return async (req) => {
    const unbounded = req.effects.some((e) => UNBOUNDED.has(e));
    if (opts.autoAllow && !unbounded) return "allow-session";
    if (!process.stdin.isTTY || opts.interactive === false) return "deny";

    process.stderr.write(`\n${bold(`Approve ${req.toolName}?`)}\n`);
    // Surface WHY this call was escalated (risk annotation / checkpoint) before the choices — a human must
    // see "writes a sensitive file" / "CRITICAL risk" to decide meaningfully.
    if (/risk:|checkpoint/i.test(req.decision.reason)) {
      process.stderr.write(`${bad(`  ⚠ ${req.decision.reason}`)}\n`);
    }
    for (const line of previewFor(req.args)) process.stderr.write(`${line}\n`);

    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const ans = (await rl.question("  [y] once  [a] session  [n] deny > ")).trim().toLowerCase();
      if (ans === "y" || ans === "yes") return "allow-once";
      if (ans === "a" || ans === "all") return "allow-session";
      return "deny";
    } finally {
      rl.close();
    }
  };
}
