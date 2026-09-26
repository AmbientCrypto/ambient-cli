import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { AmbientTheme } from "../theme.js";

export interface SkillRow {
  name: string;
  source: string;
  description: string;
  pinned: boolean;
  /** False when the skill opts out of being run as `/name`. */
  userInvocable?: boolean;
  /** What to type after `/name`. */
  argumentHint?: string;
}

/**
 * The interactive skills browser (the `/skills` overlay) — a scrollable, type-to-filter list of EVERY skill
 * the agent can reach (yours + Claude/Codex/plugins), with a `◆` marker on pinned ones. ↑/↓ navigate, typing
 * narrows the list, Space pins/unpins the selection, Enter drops "use the <name> skill" into the composer,
 * Esc closes. A calm framed panel; cyan marks only the cursor + pinned marks (the brand's ~10% accent).
 */
export function SkillsBrowser({
  rows,
  selected,
  filter,
  total,
  width,
  maxRows,
}: {
  rows: SkillRow[];
  selected: number;
  filter: string;
  /** The unfiltered total (for the header count). */
  total: number;
  width: number;
  /** Cap on visible rows (from the terminal height) so the overlay never overflows the composer. */
  maxRows?: number;
}): ReactNode {
  const boxW = Math.max(0, Math.min(width - 2, 120));
  const max = Math.max(3, Math.min(12, maxRows ?? 12));
  const start = Math.max(
    0,
    Math.min(selected - Math.floor(max / 2), Math.max(0, rows.length - max)),
  );
  const shown = rows.slice(start, start + max);
  const above = start;
  const below = rows.length - (start + shown.length);
  const idW = Math.max(14, Math.min(34, boxW - 30)); // fixed name column so the metadata forms a straight edge

  return (
    <Box
      flexDirection="column"
      width={boxW}
      borderStyle="round"
      borderColor={AmbientTheme.signal}
      paddingX={2}
    >
      <Text color={AmbientTheme.dim} wrap="truncate">
        {`Skills · ${rows.length}/${total} · ↑/↓ move · tab pin · enter use · esc close`}
      </Text>
      <Box>
        <Text color={AmbientTheme.dim}>filter: </Text>
        <Text color={AmbientTheme.fg}>{filter}</Text>
        <Text color={AmbientTheme.signal}>▋</Text>
      </Box>
      {rows.length === 0 ? (
        <Text color={AmbientTheme.dim}>{"  no skills match — clear the filter (backspace)"}</Text>
      ) : null}
      {above > 0 ? <Text color={AmbientTheme.dim}>{`  … ${above} above`}</Text> : null}
      {shown.map((r, k) => {
        const active = start + k === selected;
        return (
          <Box key={r.name}>
            <Box width={2} flexShrink={0}>
              <Text color={AmbientTheme.cyan}>{active ? "▸ " : "  "}</Text>
            </Box>
            {/* ◆ = pinned (always loads), dim ○ = not — cyan is the pin/active accent, not spent per row */}
            <Box width={2} flexShrink={0}>
              <Text color={r.pinned ? AmbientTheme.cyan : AmbientTheme.dim}>
                {r.pinned ? "◆ " : "○ "}
              </Text>
            </Box>
            <Box width={idW} flexShrink={0}>
              <Text
                color={active ? AmbientTheme.cyan : AmbientTheme.fg}
                bold={active}
                wrap="truncate"
              >
                {r.name}
              </Text>
            </Box>
            <Box flexGrow={1}>
              <Text color={AmbientTheme.dim} wrap="truncate">
                {`  ${r.description.replace(/\s+/g, " ").trim()}`}
              </Text>
            </Box>
          </Box>
        );
      })}
      {below > 0 ? <Text color={AmbientTheme.dim}>{`  … ${below} below`}</Text> : null}
    </Box>
  );
}
