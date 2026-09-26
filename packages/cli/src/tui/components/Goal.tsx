import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { PlanTask } from "../state.js";
import { AmbientTheme } from "../theme.js";

/**
 * The pinned north-star line (set via `/goal`). One glanceable row above the transcript that stays put every
 * turn — the ◎ glyph reads as "the goal", the objective is truncated to the terminal width, and a compact
 * progress token (steps done/total, from the live plan) sits on the right. Absent until a goal is set (honest
 * empty state). The glyph brightens to the accent while the agent is actively working toward it.
 */
export function Goal({
  goal,
  plan,
  running,
}: {
  goal?: string;
  plan: PlanTask[];
  running?: boolean;
}): ReactNode {
  if (!goal) return null;
  const total = plan.length;
  const done = plan.filter((t) => t.status === "done").length;
  const progress = total > 0 ? `${done}/${total}` : "—";
  return (
    <Box marginTop={1}>
      <Text color={running ? AmbientTheme.signal : AmbientTheme.dim}>◎ </Text>
      <Text color={AmbientTheme.dim} bold>
        goal{"  "}
      </Text>
      <Box flexGrow={1} flexShrink={1}>
        <Text color={AmbientTheme.fg} wrap="truncate-end">
          {goal}
        </Text>
      </Box>
      <Text color={AmbientTheme.dim}>{`  ${progress}`}</Text>
    </Box>
  );
}
