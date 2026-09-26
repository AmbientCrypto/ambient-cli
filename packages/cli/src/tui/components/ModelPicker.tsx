import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { FleetRow } from "../../render/fleet.js";
import { AmbientTheme } from "../theme.js";

/**
 * An interactive model picker over the live fleet. ↑/↓ move the selection, Enter picks, Esc cancels. The
 * current model is marked. No readiness marks: the catalog's flag is only a hint (flagged models serve), and a
 * model that really can't answer fails over.
 */
export function ModelPicker({
  rows,
  selected,
  current,
  width,
}: {
  rows: FleetRow[];
  selected: number;
  current: string;
  width: number;
}): ReactNode {
  const boxW = Math.max(0, Math.min(width - 2, 120));
  const max = 10;
  // Keep the selection in view by windowing around it.
  const start = Math.max(
    0,
    Math.min(selected - Math.floor(max / 2), Math.max(0, rows.length - max)),
  );
  const shown = rows.slice(start, start + max);
  const above = start;
  const below = rows.length - (start + shown.length);
  const idW = Math.max(12, Math.min(30, boxW - 24)); // fixed id column so the metadata forms a straight edge

  return (
    <Box
      flexDirection="column"
      width={boxW}
      borderStyle="round"
      borderColor={AmbientTheme.signal}
      paddingX={2}
    >
      <Text color={AmbientTheme.dim} wrap="truncate">
        Pick a model · ↑/↓ then enter · esc to cancel
      </Text>
      {above > 0 ? <Text color={AmbientTheme.dim}>{`  … ${above} above`}</Text> : null}
      {shown.map((r, k) => {
        const i = start + k;
        const active = i === selected;
        // "current" FIRST so it survives when the metadata clips on a narrow terminal, in a FIXED-width column
        // so the context size, vision and lane that follow line up as a clean grid.
        const status = (r.id === current ? "· current" : "").padEnd(9);
        const vision = r.vision === "vision:yes" ? "vision" : "";
        const meta = `${status}  ${r.ctx.padEnd(5)} ${vision.padEnd(6)} ${r.lane}`;
        return (
          <Box key={r.id}>
            <Box width={2} flexShrink={0}>
              <Text color={AmbientTheme.cyan}>{active ? "▸ " : "  "}</Text>
            </Box>
            <Box width={idW} flexShrink={0}>
              <Text
                color={active ? AmbientTheme.cyan : AmbientTheme.dim}
                bold={active}
                wrap="truncate"
              >
                {r.id}
              </Text>
            </Box>
            <Box flexGrow={1}>
              <Text color={AmbientTheme.dim} wrap="truncate">
                {`  ${meta}`}
              </Text>
            </Box>
          </Box>
        );
      })}
      {below > 0 ? <Text color={AmbientTheme.dim}>{`  … ${below} below`}</Text> : null}
    </Box>
  );
}
