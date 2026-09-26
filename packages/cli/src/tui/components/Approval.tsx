import type { Effect, PermissionDecision } from "@amb/protocol";
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { type PreviewKind, toolPreviewBody } from "../../presentation/tool-preview.js";
import { clipText } from "../clip.js";
import { AmbientTheme as T } from "../theme.js";

export interface ApprovalRequest {
  toolName: string;
  args: unknown;
  effects: Effect[];
  decision: PermissionDecision;
}

/** The choices, in visual/list order — the App's selection index maps 1:1 to this array. Escalating scope:
 *  this call → this tool for the session → EVERY tool for the session (bypass) → refuse. `allow-session`'s
 *  description is filled per-tool at render. */
export const APPROVAL_OPTIONS = [
  { key: "allow-once", badge: "y", label: "Allow once", desc: "run this one action" },
  { key: "allow-session", badge: "a", label: "Allow session", desc: "" },
  { key: "bypass", badge: "b", label: "Bypass session", desc: "skip all prompts this session" },
  { key: "deny", badge: "n", label: "Deny", desc: "refuse" },
] as const;
export type ApprovalDecision = (typeof APPROVAL_OPTIONS)[number]["key"];
const DENY_SEL = APPROVAL_OPTIONS.length - 1;

const RISK_RE = /risk:|checkpoint/i;
/** The safe default selection: deny (the last row) when the request was escalated for risk, else allow-once. */
export const defaultApprovalSel = (reason: string): number => (RISK_RE.test(reason) ? DENY_SEL : 0);

/** The two input paths, resolved to ONE outcome (pure — the App just dispatches it). Arrows move the cursor
 *  (clamped, never wrapping); Enter/Space confirm the selected row; y/a/b/n jump-and-confirm in one keystroke;
 *  Esc denies (safe cancel); Ctrl+C aborts the whole run. Anything else is ignored (no accidental confirm). */
export type ApprovalKeyResult =
  | { t: "move"; sel: number }
  | { t: "confirm"; decision: ApprovalDecision }
  | { t: "abort" }
  | { t: "none" };
/** How long an approval prompt ignores keys after it appears (only Esc and Ctrl+C count meanwhile). */
export const APPROVAL_SETTLE_MS = 700;

export function resolveApprovalKey(
  ch: string,
  key: {
    upArrow?: boolean;
    downArrow?: boolean;
    return?: boolean;
    escape?: boolean;
    ctrl?: boolean;
    meta?: boolean;
  },
  sel: number,
  /** How long the prompt has been on screen (ms). */
  shownForMs = Number.POSITIVE_INFINITY,
): ApprovalKeyResult {
  if (key.ctrl && ch === "c") return { t: "abort" };
  if (key.escape) return { t: "confirm", decision: "deny" }; // safe cancel
  // Keys that arrive right as the prompt appears were meant for what you were typing (a message to the
  // agent), not an answer — a letter mid-word must never allow, or switch the session to bypass.
  if (shownForMs < APPROVAL_SETTLE_MS) return { t: "none" };
  // A burst of several characters is typing or a paste, never a deliberate answer.
  if (ch.length > 1) return { t: "none" };
  // A MODIFIED key must never approve: Ink reports Ctrl+A as ch:"a"+ctrl, which would otherwise hit the `a`
  // (allow-session) branch — so Ctrl+A / Ctrl+Y / Meta+letter can't grant anything. Arrows, Enter
  // and the letter hotkeys are all UNMODIFIED, so gating ctrl/meta here is safe.
  if (key.ctrl || key.meta) return { t: "none" };
  // Normalize a corrupted/out-of-range selection to the safe row (deny) before any arrow math.
  const s = Number.isInteger(sel) && sel >= 0 && sel <= DENY_SEL ? sel : DENY_SEL;
  if (key.upArrow) return { t: "move", sel: Math.max(0, s - 1) };
  if (key.downArrow) return { t: "move", sel: Math.min(DENY_SEL, s + 1) };
  if (key.return || ch === " ")
    return { t: "confirm", decision: APPROVAL_OPTIONS[s]?.key ?? "deny" };
  if (ch === "y") return { t: "confirm", decision: "allow-once" };
  if (ch === "a") return { t: "confirm", decision: "allow-session" };
  if (ch === "b") return { t: "confirm", decision: "bypass" };
  if (ch === "n") return { t: "confirm", decision: "deny" };
  return { t: "none" };
}

/** One preview line: newlines flattened, then truncated to `max` columns so nothing wraps the modal. */
const line = clipText;

const colorFor = (kind: PreviewKind): string =>
  kind === "add" ? T.add : kind === "del" ? T.bad : T.dim;

/** One selectable choice row: a fixed 2+4+15 column grid so the eye scans straight down. The ▸ cursor (not
 *  color) is the load-bearing selection signal, so it survives NO_COLOR; cyan+bold only ever lands on the
 *  active row (keeps the accent ~10%). */
function Choice({
  active,
  badge,
  label,
  desc,
  hint,
  spaced,
  compact,
}: {
  active: boolean;
  badge: string;
  label: string;
  desc: string;
  hint?: string;
  spaced?: boolean;
  compact?: boolean;
}): ReactNode {
  const accent = active ? T.cyan : T.dim;
  return (
    <Box marginTop={spaced ? 1 : 0}>
      {/* the fixed columns never shrink (so labels/hints can't wrap into extra rows); only the desc shrinks */}
      <Box width={2} flexShrink={0}>
        <Text color={T.cyan}>{active ? "▸ " : "  "}</Text>
      </Box>
      <Box width={4} flexShrink={0}>
        <Text color={accent}>{`[${badge}]`}</Text>
      </Box>
      <Box width={compact ? undefined : 15} flexShrink={compact ? 1 : 0}>
        <Text color={accent} bold={active} wrap="truncate">
          {label}
        </Text>
      </Box>
      {compact ? null : (
        <Box flexGrow={1}>
          <Text color={T.dim} wrap="truncate">
            {desc}
          </Text>
        </Box>
      )}
      {hint && !compact ? <Text color={T.dim}>{hint}</Text> : null}
    </Box>
  );
}

/**
 * The permission modal (Native-calm, the design-panel winner). A framed pop-up in the input region when the
 * agent needs sign-off: a plain-English decision header ("Allow write to src/util.ts?"), the exact change
 * bound in a dim │-gutter preview, and the four choices as a proper SELECTABLE list — a ▸ cursor moved by
 * ↑/↓ + Enter, with [y]/[a]/[b]/[n] hotkeys fused to each row so arrows and letters are one control. Restrained:
 * one elevation, thin rules for depth, cyan only on the active row. `selected` (0..3) comes from the App.
 */
export function Approval({
  req,
  width,
  selected,
  maxPreview = 14,
}: {
  req: ApprovalRequest;
  width: number;
  selected: number;
  /** Preview-line budget — the App shrinks this on a short terminal so the CHOICES never scroll off. */
  maxPreview?: number;
}): ReactNode {
  const args = req.args as { command?: string; path?: string } | undefined;
  const command = typeof args?.command === "string" ? args.command : undefined;
  const path = typeof args?.path === "string" ? args.path : undefined;
  const boxW = Math.max(0, Math.min(width - 2, 120));
  const inner = Math.max(1, boxW - 6); // interior inside border + paddingX:2
  // Supported minimum ≈ 21 cols (inner ≥ 13): the header + choice grid fit without wrapping there and up. Below
  // that the modal degrades gracefully (Ink truncates). Preview lines are clipped by display width.

  const effects = req.effects.join(" · ");
  const showEffects = inner > "Permission needed".length + effects.length + 2;
  const isRisk = RISK_RE.test(req.decision.reason);
  const compact = inner < 40; // hide descriptions + the Esc hint on a narrow terminal so nothing wraps
  // Truncate the tool name for the header so a long MCP name (`mcp__server__tool`) can't overflow the one-line
  // sentence. Reserve MORE room when a path follows ("Allow <tool> to <path>?" = tool + path + 11 connective
  // cols) than for the bare "Allow <tool>?" form, so the header can never exceed `inner` and wrap.
  const tool = line(req.toolName, Math.max(1, Math.min(32, inner - (path ? 12 : 8))));

  // The App shrinks maxPreview on a short terminal; allow it to reach ZERO so the CHOICES always win the
  // vertical budget (a risk callout + overflow marker are also in the fixed furniture).
  const previewBudget = Math.max(0, Math.floor(maxPreview));
  const {
    lines: preview,
    hidden,
    charTruncated,
  } = previewBudget > 0
    ? toolPreviewBody(req.args, previewBudget)
    : { lines: [], hidden: 0, charTruncated: false };

  return (
    <Box
      flexDirection="column"
      width={boxW}
      borderStyle="round"
      borderColor={T.signal}
      paddingX={2}
    >
      {/* overline: what kind of ask + the effects, right-aligned (omitted when it would crowd) */}
      <Box marginTop={1}>
        <Text color={T.dim}>Permission needed</Text>
        {showEffects ? (
          <>
            <Box flexGrow={1} />
            <Text color={T.dim}>{effects}</Text>
          </>
        ) : null}
      </Box>

      {/* plain-English decision header — the verb/target emphasized, connectives dim (graft: Decisive) */}
      <Box marginTop={1}>
        {command ? (
          <>
            <Text color={T.dim}>Run </Text>
            <Text color={T.fg} bold>
              {line(command, Math.max(1, inner - 5))}
            </Text>
            <Text color={T.dim}>?</Text>
          </>
        ) : path ? (
          <>
            <Text color={T.dim}>Allow </Text>
            <Text color={T.cyan} bold>
              {tool}
            </Text>
            <Text color={T.dim}> to </Text>
            <Text color={T.fg} bold>
              {line(path, Math.max(1, inner - tool.length - 11))}
            </Text>
            <Text color={T.dim}>?</Text>
          </>
        ) : (
          <>
            <Text color={T.dim}>Allow </Text>
            <Text color={T.cyan} bold>
              {tool}
            </Text>
            <Text color={T.dim}>?</Text>
          </>
        )}
      </Box>

      {/* risk callout, adjacent to its cause — the only place red is used, only the ⚠ glyph */}
      {isRisk ? (
        <Box>
          <Text color={T.bad}>{line(`⚠ ${req.decision.reason}`, inner)}</Text>
        </Box>
      ) : null}

      {/* the change, bound in a dim │-gutter under a dotted rule (graft: Preview-forward's gutter) */}
      {preview.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={T.dim}>{"┄".repeat(inner)}</Text>
          {preview.map((l, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a preview snapshot never reorders within a render
            <Box key={i}>
              <Text color={T.dim}>│ </Text>
              <Text color={colorFor(l.kind)}>{line(l.text || " ", inner - 2)}</Text>
            </Box>
          ))}
          {charTruncated ? (
            <Text color={T.dim}>{`│ ${line("… (truncated)", inner - 2)}`}</Text>
          ) : hidden > 0 ? (
            <Text color={T.dim}>{`│ ${line(`… ${hidden} more lines`, inner - 2)}`}</Text>
          ) : null}
        </Box>
      ) : null}

      {/* thin rule, then the selectable choices */}
      <Box marginTop={1}>
        <Text color={T.dim}>{"─".repeat(inner)}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {APPROVAL_OPTIONS.map((o, i) => {
          const isDeny = o.key === "deny";
          const desc =
            o.key === "allow-session" ? `auto-allow ${req.toolName} this session` : o.desc;
          return (
            <Choice
              key={o.key}
              active={selected === i}
              badge={o.badge}
              label={o.label}
              desc={desc}
              spaced={isDeny}
              compact={compact}
              {...(isDeny ? { hint: "Esc" } : {})}
            />
          );
        })}
      </Box>
    </Box>
  );
}
