import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { mmss } from "../format.js";
import { THINKING_GLOBE } from "../globe.js";
import { type Activity, PREPARING_TOOL } from "../state.js";
import { AmbientTheme } from "../theme.js";

/**
 * The one live line, shown ONLY while a run is active: the Ambient globe SPINNING (a real rotating braille
 * orb, INLINE on one row) + what the agent is doing right now (Thinking / Reading / Editing / Running …) +
 * the running elapsed time. `frame` advances on a steady timer so the globe turns even between tokens. The
 * verb + phase clock always stay on-screen; the volatile detail shrinks + truncates in the middle.
 */
export function ActivityLine({
  activity,
  elapsed,
  phaseElapsed,
  frame,
  width = 80,
  effort,
  stream,
  now = Date.now(),
}: {
  activity?: Activity;
  elapsed: number;
  /** Time in the CURRENT phase (this verb) — shown next to the verb; the run total sits after it. */
  phaseElapsed?: number;
  frame: number;
  width?: number;
  /** The reasoning effort actually in use — shown next to "Thinking" so you see how hard it's reasoning. */
  effort?: "none" | "high" | "max";
  /** The model call in flight — how much it has produced so far, and how fast. */
  stream?: { chars: number; since?: number; tokens?: number; hidden?: number };
  /** Wall clock (ms), for the rate; defaults to now. */
  now?: number;
}): ReactNode {
  if (!activity) return null;
  const globe =
    THINKING_GLOBE[
      ((frame % THINKING_GLOBE.length) + THINKING_GLOBE.length) % THINKING_GLOBE.length
    ] ??
    THINKING_GLOBE[0] ??
    "";
  const globeW = globe.length + 1; // globe cells + a 1-col gap before the verb
  const phase = phaseElapsed !== undefined ? phaseElapsed : elapsed;
  const rowW = Math.max(0, Math.min(width - 2, 120));
  const textW = Math.max(6, rowW - globeW);
  const showRun = elapsed - phase > 1 && textW >= 40;
  // The verb carries the effort while THINKING ("Thinking · high") so the user sees how hard it's reasoning
  // — including the concrete level behind an `auto` setting.
  const verbText =
    effort && effort !== "none" && activity.verb === "Thinking"
      ? `${activity.verb} · ${effort}`
      : activity.verb;
  // Bound the verb STRING (when there's no shrinkable detail) to what's left after the clock, so a long verb
  // like "Fixing failed verification" can't clip the priority phase clock on a narrow row.
  // Live output stats only when there's room for them beside the verb and clock.
  const statsText = streamStats(activity.verb, stream, now);
  const stats = statsText && textW >= 50 ? statsText : undefined;
  const clockW =
    `  ·  ${mmss(phase)}`.length +
    (showRun ? `  (run ${mmss(elapsed)})`.length : 0) +
    (stats ? stats.length + 2 : 0);
  const verbBudget = activity.detail ? undefined : Math.max(3, textW - clockW);
  const verb =
    verbBudget !== undefined && verbText.length > verbBudget
      ? `${verbText.slice(0, Math.max(1, verbBudget - 1))}…`
      : verbText;
  return (
    <Box marginTop={1} width={rowW}>
      {/* The spinning Ambient globe — a real rotating braille orb, inline, brand signal blue. */}
      <Box flexShrink={0}>
        <Text color={AmbientTheme.signal}>{`${globe} `}</Text>
        <Text color={AmbientTheme.fg} bold wrap="truncate">
          {verb}
        </Text>
      </Box>
      {stats ? (
        <Box flexShrink={0}>
          <Text color={AmbientTheme.dim}>{`  ${stats}`}</Text>
        </Box>
      ) : null}
      {activity.detail ? (
        <Box flexShrink={1} minWidth={0}>
          <Text color={AmbientTheme.dim} wrap="truncate-middle">
            {`  ${activity.detail}`}
          </Text>
        </Box>
      ) : null}
      <Box flexShrink={0}>
        <Text color={AmbientTheme.dim}>{`  ·  ${mmss(phase)}`}</Text>
        {showRun ? <Text color={AmbientTheme.dim}>{`  (run ${mmss(elapsed)})`}</Text> : null}
      </Box>
    </Box>
  );
}

/** Characters per token for the live estimate (the exact count replaces it when the response reports it). */
const CHARS_PER_TOKEN = 3.5;

/**
 * "↓ 1.2k tok · 41 tok/s" while the model is producing (thinking or answering); nothing during tool work or
 * before the first token. The count is an estimate from streamed text until the provider reports the real one.
 */
export function streamStats(
  verb: string,
  stream: { chars: number; since?: number; tokens?: number; hidden?: number } | undefined,
  now: number,
): string | undefined {
  if (!stream || (verb !== "Thinking" && verb !== "Answering" && verb !== PREPARING_TOOL))
    return undefined;
  const tokens = stream.tokens ?? Math.round(stream.chars / CHARS_PER_TOKEN) + (stream.hidden ?? 0);
  if (tokens <= 0) return undefined;
  const count = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
  const secs = stream.since !== undefined ? (now - stream.since) / 1000 : 0;
  const rate = secs >= 2 ? `  ·  ${Math.round(tokens / secs)} tok/s` : "";
  return `↓ ${count} tok${rate}`;
}
