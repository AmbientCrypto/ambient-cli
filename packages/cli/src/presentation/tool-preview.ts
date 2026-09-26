/**
 * ONE pure builder for the change-preview a user sees when APPROVING a mutation — shared by the line-mode
 * approver and the Ink modal so both show the SAME content (they previously disagreed: 8k vs 20k char caps,
 * and only one supported a pre-computed `diff`). The preview authorizes a mutation, so the two surfaces must
 * never differ on WHAT is being approved. Returns semantic add/del/ctx lines; each renderer applies colors +
 * its own line budget (a modal fits fewer lines than scrollback — a display choice, not a content difference).
 */

export type PreviewKind = "add" | "del" | "ctx";
export interface PreviewLine {
  kind: PreviewKind;
  text: string;
}
export interface ToolPreviewBody {
  lines: PreviewLine[];
  /** Lines beyond `maxLines` that were withheld (for an honest "N more lines" marker). */
  hidden: number;
  /** A raw value was char-truncated — show a GENERIC "(truncated)" marker, not a misleading exact count. */
  charTruncated: boolean;
}

/** Bound the diff/content preview so a multi-MB `content` can't stall a render or flood the terminal. */
export const PREVIEW_MAX_CHARS = 8_000;

/**
 * Build the change body from a tool's INPUT args (approval fires BEFORE execution, so no applied diff exists):
 * a pre-supplied `diff` is honored; else `edit` shows oldString→newString; else `write` shows content as
 * additions. `command`/`path` are rendered by the caller (header vs inline differs per surface).
 */
export function toolPreviewBody(
  args: unknown,
  maxLines: number,
  maxChars: number = PREVIEW_MAX_CHARS,
): ToolPreviewBody {
  const a = args as Record<string, unknown> | undefined;
  let charTruncated = false;
  const bound = (s: string | undefined): string | undefined => {
    if (s === undefined) return undefined;
    if (s.length > maxChars) {
      charTruncated = true;
      return s.slice(0, maxChars);
    }
    return s;
  };
  const diff = bound(typeof a?.diff === "string" ? a.diff : undefined);
  const oldStr = bound(typeof a?.oldString === "string" ? a.oldString : undefined);
  const newStr = bound(typeof a?.newString === "string" ? a.newString : undefined);
  const content = bound(typeof a?.content === "string" ? a.content : undefined);

  const raw: PreviewLine[] = [];
  if (diff !== undefined) {
    for (const l of diff.split("\n")) {
      const kind: PreviewKind =
        l.startsWith("+") && !l.startsWith("+++")
          ? "add"
          : l.startsWith("-") && !l.startsWith("---")
            ? "del"
            : "ctx";
      raw.push({ kind, text: l });
    }
  } else if (Array.isArray(a?.edits)) {
    // `apply_patch` — a multi-file edit; show each hunk under its file path so a multi-file mutation is never
    // approved blind.
    for (const e of a.edits) {
      const spec = (e && typeof e === "object" ? e : {}) as Record<string, unknown>;
      if (typeof spec.path === "string") raw.push({ kind: "ctx", text: `# ${spec.path}` });
      for (const l of (bound(typeof spec.oldString === "string" ? spec.oldString : "") ?? "").split(
        "\n",
      ))
        raw.push({ kind: "del", text: `- ${l}` });
      for (const l of (bound(typeof spec.newString === "string" ? spec.newString : "") ?? "").split(
        "\n",
      ))
        raw.push({ kind: "add", text: `+ ${l}` });
    }
  } else if (oldStr !== undefined || newStr !== undefined) {
    for (const l of (oldStr ?? "").split("\n")) raw.push({ kind: "del", text: `- ${l}` });
    for (const l of (newStr ?? "").split("\n")) raw.push({ kind: "add", text: `+ ${l}` });
  } else if (content !== undefined) {
    for (const l of content.split("\n")) raw.push({ kind: "add", text: `+ ${l}` });
  }
  const lines = raw.slice(0, maxLines);
  return { lines, hidden: Math.max(0, raw.length - lines.length), charTruncated };
}
