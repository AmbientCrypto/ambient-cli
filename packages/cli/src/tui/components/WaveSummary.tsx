import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { mmss } from "../format.js";
import { globeFrame } from "../logo.js";
import type { WaveState } from "../state.js";
import { AmbientTheme } from "../theme.js";

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, Math.max(1, max - 1))}…` : flat;
}

/**
 * The LIVE subagent wave — a small, FIXED-HEIGHT panel (never a tall re-rendering tree, so the dynamic frame
 * stays well under the viewport and never scroll-strands/strobes). The globe animates off the steady view tick
 * (decoupled from event volume). Collapsed = header + one current action (≤2 lines); expanded (↓/Ctrl+O) = one
 * line per running child, bounded by the wave's action ring (≤5 lines). Each child's DURABLE result is a
 * `subagent-line` in scrollback — scroll up to read what they did (like Claude's Task output).
 */
export function WaveSummary({
  wave,
  frame,
  elapsed,
  expanded = false,
  width = 80,
}: {
  wave: WaveState;
  /** Steady spinner frame (the 120ms view tick) — animates the globe without event-driven relayout. */
  frame: number;
  /** Seconds since the wave began (computed in the view from a ref; keeps the reducer pure). */
  elapsed: number;
  expanded?: boolean;
  width: number;
}): ReactNode {
  const running = Math.max(0, wave.total - wave.done);
  const header = `${running}/${wave.total} ${wave.roleWord} running · ${mmss(elapsed)}${
    expanded ? " · ↑ collapse" : " · ↓ / ctrl+o to view"
  }`;
  // Collapsed: only the most-recent action. Expanded: the whole bounded ring (already ≤ MAX_WAVE_ACTIONS).
  const shown = expanded ? wave.actions : wave.actions.slice(-1);
  const detailW = Math.max(8, Math.min(width - 2, 120) - 6);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={AmbientTheme.cyan}>{`◆ ${globeFrame(frame, true)} `}</Text>
        <Text color={AmbientTheme.fg}>subagent</Text>
        <Text color={AmbientTheme.dim}>{`   ${header}`}</Text>
      </Box>
      {shown.map((a) => (
        <Box key={a.childSessionId}>
          <Box flexShrink={0}>
            <Text color={AmbientTheme.dim}>{"  ↳ "}</Text>
            <Text color={AmbientTheme.fg}>{`${oneLine(a.label, 18).padEnd(18)}  `}</Text>
          </Box>
          <Box flexShrink={1} minWidth={0}>
            <Text color={AmbientTheme.dim} wrap="truncate">
              {oneLine(a.text || "working", detailW)}
            </Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}
