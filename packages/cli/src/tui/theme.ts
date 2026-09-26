/**
 * Ambient brand tokens for the terminal (see docs/design/AMBIENT-BRAND.md for the full palette).
 * Restrained color: the screen is mostly neutral; CYAN marks only what is live / active / key. Only the
 * tokens the UI actually renders live here — the brand doc is the source of truth for the rest.
 */
export const AmbientTheme = {
  cyan: "#4A93B2", // Ambient Cyan — the accent (~10% of the screen)
  signal: "#1893EB", // Signal Blue — brighter interactive accent (streaming, focus)
  // Dominant text uses the terminal's DEFAULT foreground (undefined = no color override) so it is legible on
  // BOTH light and dark terminals — a hardcoded #FFFFFF was invisible on a light background. The
  // remaining tokens are mid-tones readable on either.
  fg: undefined as string | undefined,
  dim: "gray", // secondary text (overlines, metadata, help) — a mid-gray, readable on light AND dark
  add: "green", // diff additions — conventional/semantic, deliberately NOT the cyan accent
  bad: "#C25B5B", // errors + diff deletions
} as const;
