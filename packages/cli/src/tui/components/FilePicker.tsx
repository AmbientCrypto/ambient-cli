import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { clipText } from "../clip.js";
import { AmbientTheme } from "../theme.js";

/** The `@` file picker shown under the composer while a mention is being typed. */
export function FilePicker({
  files,
  selected,
  width,
}: {
  files: readonly string[];
  selected: number;
  width: number;
}): ReactNode {
  if (files.length === 0) return null;
  const boxW = Math.max(0, Math.min(width - 2, 120));
  const max = 8;
  const start = Math.max(
    0,
    Math.min(selected - Math.floor(max / 2), Math.max(0, files.length - max)),
  );
  const shown = files.slice(start, start + max);
  return (
    <Box
      flexDirection="column"
      width={boxW}
      borderStyle="round"
      borderColor={AmbientTheme.signal}
      paddingX={2}
    >
      <Text color={AmbientTheme.dim} wrap="truncate">
        Files · ↑/↓ then tab or enter · esc to close
      </Text>
      {shown.map((f, k) => {
        const active = start + k === selected;
        return (
          <Box key={f}>
            <Box width={2} flexShrink={0}>
              <Text color={AmbientTheme.cyan}>{active ? "▸ " : "  "}</Text>
            </Box>
            <Text color={active ? AmbientTheme.fg : AmbientTheme.dim} bold={active}>
              {clipText(f, Math.max(4, boxW - 8))}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
