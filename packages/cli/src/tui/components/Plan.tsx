import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { PlanTask } from "../state.js";
import { AmbientTheme } from "../theme.js";

/** Task glyph: ✓ done (green = success, NOT the accent) · ◐ active (signal = the one live step) · ○ pending (dim). */
function glyph(status: PlanTask["status"]): { g: string; color: string } {
  if (status === "done") return { g: "✓", color: AmbientTheme.add };
  if (status === "active") return { g: "◐", color: AmbientTheme.signal };
  return { g: "○", color: AmbientTheme.dim };
}

/**
 * The pinned task list — the agent's plan (maintained via the `plan` tool), like Claude Code's todo
 * list. Absent until the model actually uses it (honest empty state). Done steps strike through; the
 * step in progress is bold. A `done/total` count sits on the header. BOUNDED to `max` visible rows
 * (windowed around the active step) so a 50-step plan can't push the composer off the screen.
 */
export function Plan({ tasks, max = 8 }: { tasks: PlanTask[]; max?: number }): ReactNode {
  if (tasks.length === 0) return null;
  const done = tasks.filter((t) => t.status === "done").length;
  const activeIdx = tasks.findIndex((t) => t.status === "active");
  const anchor = activeIdx >= 0 ? activeIdx : Math.min(done, tasks.length - 1);
  const start = Math.max(
    0,
    Math.min(anchor - Math.floor(max / 2), Math.max(0, tasks.length - max)),
  );
  const shown = tasks.slice(start, start + max);
  const above = start;
  const below = tasks.length - (start + shown.length);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={AmbientTheme.dim}>{`Plan  ${done}/${tasks.length}`}</Text>
      {above > 0 ? <Text color={AmbientTheme.dim}>{`  … ${above} above`}</Text> : null}
      {shown.map((t, i) => {
        const { g, color } = glyph(t.status);
        const active = t.status === "active";
        const n = start + i + 1; // 1-based step number → reads as "step 1 / 2 / 3"
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: the plan is a stable ordered list within a render
          <Box key={start + i}>
            <Text color={AmbientTheme.dim}>{`  ${String(n).padStart(2, " ")}. `}</Text>
            <Text color={color}>{`${g} `}</Text>
            <Text
              // only the ACTIVE step is loud (bold fg); done + pending are both dim, so the eye lands on "now"
              color={active ? AmbientTheme.fg : AmbientTheme.dim}
              strikethrough={t.status === "done"}
              bold={active}
              wrap="truncate"
            >
              {t.text}
            </Text>
          </Box>
        );
      })}
      {below > 0 ? <Text color={AmbientTheme.dim}>{`  … ${below} below`}</Text> : null}
    </Box>
  );
}
