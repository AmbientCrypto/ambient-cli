# Ambient Brand → Terminal Design System (for the `amb` TUI)

> Extracted from the Ambient Brand Guidelines v1.0 (Dec 2025). This is the source of truth for the TUI's
> look. The brand is precise, restrained, confident — "The Sage." We translate it to the terminal honestly.

## Colors (truecolor)
| Token | Hex | Role in the TUI |
|---|---|---|
| **Ambient Cyan** | `#4A93B2` | THE accent. Logo, active/ready state, key highlights, the mode chip. Use sparingly (10%). |
| **Signal Blue** | `#1893EB` | Brighter interactive accent — links, the streaming cursor, focus. Sparing. |
| **Core Blue** | `#00264F` | Deep containers / selected backgrounds (dark). |
| **Substrate** | `#D2E4EC` | Faint fills, subtle rules on light. |
| White / default fg | `#FFFFFF` | Dominant text (60%). The "white canvas + breathing room." |
| Dim gray | 256-gray | Secondary text (30%): overlines, metadata, timestamps, help. |

Terminal palette: use truecolor when supported; degrade to the nearest 256-color; honor `NO_COLOR`
(structure via layout + glyphs, never color alone). **60% neutral / 30% dim / 10% cyan.**

## Type (terminal is monospace, so we honor the SPIRIT)
- Oswald = heavy **condensed ALL-CAPS** display. In the terminal → a bold, blocky ASCII wordmark for the
  splash/header + **uppercased section overlines** (dim). Headers are UPPERCASE, tight, confident.
- Inter = body → the default monospace transcript text. Never "shout" body text.
- **Overlines**: a dim, uppercase, letter-spaced label above a section (brand pattern).
- **Number badges**: `[01]` style — used for lists/steps/model rows.

## Visual principles → TUI rules
1. **Geometric precision** — clean box-drawing, aligned columns, a strict grid. No ragged edges.
2. **Depth through layers** — panes separated by thin rules, not heavy borders. One elevation.
3. **Restrained color** — the screen is mostly neutral; cyan marks only what's *live/active/key*.
4. **Purposeful space** — generous padding, blank lines between groups, "confident emptiness." Never dense.

## Logo (terminal)
- **Logomark** = an ASCII/Unicode orbital wireframe sphere (evoking the drawn globe of orbits).
- **Wordmark** = `AMBIENT` in a bold condensed ASCII block, in Ambient Cyan.
- Splash uses the horizontal lockup (mark + wordmark). Small contexts: the mark alone.

## Voice (already enforced elsewhere; the TUI copy obeys it)
Confident, rigorous, anti-hype. **No emojis, no rockets, no "moon", no hype.** Geometric glyphs
(● ○ ◆ ✓ ✗ ▸ ▾ · │ ─ →) are fine — they're precision marks, not emoji. Copy is terse and earned.

## Glyph set (geometric, on-brand — NOT emoji)
- readiness: `●` ready (GREEN = success) · `○` warm/unknown (dim) · `·` cold (faint). Cyan is reserved for the
  one live/selected mark (the ▸ cursor, the served-model dot) — success/settled states use GREEN, not the accent.
- status: `✓` ok (green) · `✗` fail (red) · `◐` running (signal) · `▸` selection cursor · `⇢` handoff · `↪` substitution receipt
- structure: `│ ─ ┄ ┌ ┐ └ ┘` rules & frames · `▓ �e ░` context gauge · `[01]` number badge
