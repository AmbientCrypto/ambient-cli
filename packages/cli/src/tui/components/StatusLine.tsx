import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { sliceToWidth, stringWidth } from "../clip.js";
import type { AgentMode, Effort, Permission, Status } from "../state.js";
import { AmbientTheme } from "../theme.js";

/** PLAN reads calm (read-only, safe, dim); BUILD reads active (it will make changes → the signal accent).
 *  Neither is cyan — cyan is reserved for the one live/key mark (the served-model dot). */
function agentModeStyle(m: AgentMode): { label: string; color: string } {
  return m === "plan"
    ? { label: "PLAN", color: AmbientTheme.dim }
    : { label: "BUILD", color: AmbientTheme.signal };
}
/** Permission label + color — bypass reads as a warning (full autonomy, no prompts). */
function permissionStyle(p: Permission): { label: string; color: string } {
  switch (p) {
    case "ask":
      return { label: "ask", color: AmbientTheme.dim };
    case "accept-edits":
      return { label: "accept-edits", color: AmbientTheme.dim };
    case "bypass":
      return { label: "bypass", color: AmbientTheme.bad };
  }
}

/** Effort label + color — `max` reads active (it thinks hardest), the rest stay calm. */
function effortStyle(e: Effort): { label: string; color: string | undefined } {
  switch (e) {
    case "off":
      return { label: "off", color: AmbientTheme.dim };
    case "auto":
      return { label: "auto", color: AmbientTheme.dim };
    case "high":
      return { label: "high", color: AmbientTheme.fg };
    case "max":
      return { label: "max", color: AmbientTheme.signal };
  }
}

/** Compact token count: 1234 → "1.2k", 2_500_000 → "2.5M". A live, honest cost readout. */
function shortTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

/** Short model name — drop the vendor prefix (defensive against a non-string from a malformed event). */
function shortModel(id: string): string {
  const s = typeof id === "string" ? id : String(id ?? "");
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * A smooth fractional-block gauge from an already-normalized fraction (0..1). Rounds to whole eighths so
 * a value that rounds up to a full cell (e.g. 9.9% of a 10-wide bar) carries into a full block rather
 * than vanishing; the caller normalizes NaN/negative/over-one away first.
 */
function gauge(f: number, width: number): { filled: string; empty: string } {
  const total8 = Math.round(f * width * 8);
  const full = Math.floor(total8 / 8);
  const rem = total8 % 8;
  const partials = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
  const filled = "█".repeat(full) + (rem > 0 ? (partials[rem] ?? "") : "");
  const empty = "░".repeat(Math.max(0, width - full - (rem > 0 ? 1 : 0)));
  return { filled, empty };
}

interface Seg {
  t: string;
  color?: string;
  bold?: boolean;
  /** Reverse-video (swap fg/bg) — used for the PLAN/BUILD mode pill so the mode reads big + unmistakable. */
  inverse?: boolean;
}

function segWidth(segs: Seg[]): number {
  return segs.reduce((n, s) => n + stringWidth(s.t), 0);
}

/** Clip a segment list to `max` display columns (measured, so a wide model name can't overflow). */
function clip(segs: Seg[], max: number): Seg[] {
  const out: Seg[] = [];
  let used = 0;
  for (const s of segs) {
    if (used >= max) break;
    const room = max - used;
    const w = stringWidth(s.t);
    if (w <= room) {
      out.push(s);
      used += w;
    } else {
      out.push({ ...s, t: room <= 1 ? "…" : `${sliceToWidth(s.t, room - 1)}…` });
      used = max;
    }
  }
  return out;
}

/**
 * The FLIGHTLINE — one honest line under the input box. It names the model ACTUALLY serving you
 * (`● served ←asked` when the fleet substituted a warm model — never silent), a smooth context gauge,
 * and the run state (pinned as a priority tail). Nothing else competes for the eye.
 */
export function StatusLine({
  status,
  width,
  active,
  showThinking,
}: {
  status: Status;
  width: number;
  active?: boolean;
  /** Whether the live model-reasoning view is on — surfaced as a small `think` marker so the toggle state
   *  (/thinking or Ctrl+T) is always visible, not invisible until reasoning happens to stream. */
  showThinking?: boolean;
}): ReactNode {
  const { cyan, dim, fg, signal, bad } = AmbientTheme;
  const mode = agentModeStyle(status.agentMode);
  const perm = permissionStyle(status.permission);
  const eff = effortStyle(status.effort);
  const rawFrac =
    status.contextWindow && status.promptEstimate
      ? status.promptEstimate / status.contextWindow
      : 0;
  const frac = Number.isFinite(rawFrac) ? Math.max(0, Math.min(1, rawFrac)) : 0;
  const pct = Math.round(frac * 100);
  const state = active ? "working" : (status.stopReason ?? "ready");
  // working = signal (active); a bad stop = red; ready/complete = dim (calm chrome, NOT the cyan accent).
  const stateColor = active
    ? signal
    : status.stopReason && status.stopReason !== "complete"
      ? bad
      : dim;
  // The model ACTUALLY serving you: prefer what the response reported, then the resolved target, then
  // what you asked for — so the flightline never lies about who is flying.
  const served = status.reportedModel ?? status.targetModel ?? status.requestedModel;
  const substituted = served !== status.requestedModel;
  const g = gauge(frac, 10);
  // App pads by 1 each side; the flightline aligns with the transcript (no inner padding), so width-2.
  const rowW = Math.max(0, Math.min(width - 2, 120));

  const head: Seg[] = [
    // Mode is a bold REVERSE-VIDEO pill so PLAN/BUILD reads big + unmistakable at a glance. Colour still
    // carries the calm(PLAN)/active(BUILD) distinction.
    { t: ` ${mode.label} `, color: mode.color, inverse: true, bold: true },
    { t: "  ", color: dim },
    { t: perm.label, color: perm.color },
    { t: "  ", color: dim },
    { t: "●", color: substituted ? signal : cyan },
    { t: ` ${shortModel(served)}`, color: fg, bold: true },
  ];
  if (substituted) head.push({ t: ` ←${shortModel(status.requestedModel)}`, color: dim });
  // Effort sits right next to the model it applies to (user ask). `auto` scales with mode per model.
  head.push({ t: "  effort ", color: dim }, { t: eff.label, color: eff.color });
  if (status.lane) head.push({ t: "  ", color: dim }, { t: status.lane, color: dim });
  // `think` shows when the live-reasoning view is on (toggle: /thinking or Ctrl+T) — present = on, absent = off.
  if (showThinking) head.push({ t: "  ", color: dim }, { t: "think", color: signal });
  // A live, cumulative token count (cost readout) — low priority, clips before the ctx%/state tail.
  if (status.tokensUsed && status.tokensUsed > 0)
    head.push({ t: "  ", color: dim }, { t: `${shortTokens(status.tokensUsed)} tok`, color: dim });

  // ctx% + run state are the PRIORITY TAIL (which model + how much context): both are pinned and
  // survive clipping, so the effort/lane/model in the head clip FIRST on a narrow terminal — never the ctx %.
  const ctxSegs: Seg[] = status.contextWindow
    ? [
        { t: "  ctx ", color: dim },
        { t: "▕", color: dim },
        { t: g.filled, color: frac > 0.85 ? bad : dim }, // gauge fill is calm chrome; red only when nearly full
        { t: g.empty, color: dim },
        { t: "▏", color: dim },
        { t: ` ${pct}%`, color: frac > 0.85 ? bad : dim },
      ]
    : [];
  const tail: Seg[] = [...ctxSegs, { t: "  ", color: dim }, { t: state, color: stateColor }];
  const tailW = Math.min(segWidth(tail), rowW);
  const segs = [...clip(head, Math.max(0, rowW - tailW)), ...clip(tail, rowW)];

  return (
    <Box marginTop={1}>
      <Text>
        {segs.map((s, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a per-render segment list never reorders
          <Text key={i} color={s.color} bold={s.bold} inverse={s.inverse}>
            {s.t}
          </Text>
        ))}
      </Text>
    </Box>
  );
}
