import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { Effort } from "../state.js";
import { AmbientTheme } from "../theme.js";

/** One-line rationale per choice — `auto` is recommended (it scales effort to the task + model). */
const EFFORT_HELP: Record<Effort, string> = {
  auto: "recommended — none for chat, high for work, max for hard problems and planning",
  off: "no reasoning — fastest answers",
  high: "reasons before answering — the standard level",
  max: "deepest reasoning (about twice as long) — best for hard bugs and design",
};

/**
 * An interactive reasoning-effort picker. ↑/↓ move the selection, Enter picks, Esc cancels. Offers only the
 * tiers Ambient really serves; `auto` picks one per turn, and nothing is sent to a model whose catalog entry
 * doesn't advertise `reasoning`.
 */
export function EffortPicker({
  efforts,
  selected,
  current,
  width,
}: {
  efforts: readonly Effort[];
  selected: number;
  current: Effort;
  width: number;
}): ReactNode {
  const boxW = Math.max(0, Math.min(width - 2, 120));
  return (
    <Box
      flexDirection="column"
      width={boxW}
      borderStyle="round"
      borderColor={AmbientTheme.signal}
      paddingX={2}
    >
      <Text color={AmbientTheme.dim} wrap="truncate">
        Reasoning effort · ↑/↓ then enter · esc to cancel
      </Text>
      {efforts.map((e, i) => {
        const active = i === selected;
        return (
          <Box key={e}>
            <Box width={2} flexShrink={0}>
              <Text color={AmbientTheme.cyan}>{active ? "▸ " : "  "}</Text>
            </Box>
            <Box width={8} flexShrink={0}>
              <Text color={active ? AmbientTheme.cyan : AmbientTheme.dim} bold={active}>
                {e}
              </Text>
            </Box>
            <Box flexGrow={1}>
              <Text color={AmbientTheme.dim} wrap="truncate">
                {`${EFFORT_HELP[e]}${e === current ? "  · current" : ""}`}
              </Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
