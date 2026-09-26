/**
 * The Ambient globe as a SPINNING inline mark, rendered in braille — a small orbital sphere (an elliptical
 * silhouette + meridians that sweep as it rotates about the vertical axis), one pre-computed frame per step.
 * Used as the live thinking indicator so the brand's orbital sphere literally turns, on a SINGLE line inline
 * with "Thinking · 0:06" (Claude-style custom terminal mark), not a stand-in glyph.
 *
 * Frames are computed once at load (pure trig — deterministic, no clock/random) then indexed by the activity
 * timer. Braille packs a 2×4 dot grid per cell; the sphere fills the grid as an ellipse (Rx=half-width,
 * Ry=half-height) so a wide, one-row indicator still reads as a round orb with a rotating interior.
 */

// Braille dot → bit within a cell (dots 1-8):  1 4 / 2 5 / 3 6 / 7 8
const DOT_BITS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0x01],
  [0, 1, 0x02],
  [0, 2, 0x04],
  [1, 0, 0x08],
  [1, 1, 0x10],
  [1, 2, 0x20],
  [0, 3, 0x40],
  [1, 3, 0x80],
];

function packBraille(grid: boolean[][], cols: number, rows: number): string[] {
  const lines: string[] = [];
  for (let cr = 0; cr < rows; cr++) {
    let line = "";
    for (let cc = 0; cc < cols; cc++) {
      let bits = 0;
      const bx = cc * 2;
      const by = cr * 4;
      for (const [dx, dy, bit] of DOT_BITS) {
        if (grid[by + dy]?.[bx + dx]) bits |= bit;
      }
      line += String.fromCharCode(0x2800 + bits);
    }
    lines.push(line);
  }
  return lines;
}

/** Render one frame of the wireframe globe (rotation `spin` radians about the vertical axis) as braille rows. */
function globeFrame(cols: number, rows: number, spin: number): string[] {
  const W = cols * 2;
  const H = rows * 4;
  const grid: boolean[][] = Array.from({ length: H }, () => Array<boolean>(W).fill(false));
  const cx = (W - 1) / 2;
  const cy = (H - 1) / 2;
  const Rx = cx; // fill the grid as an ellipse — a wide 1-row indicator stays a round-reading orb
  const Ry = cy;
  const set = (x: number, y: number): void => {
    const ix = Math.round(x);
    const iy = Math.round(y);
    const row = iy >= 0 && iy < H ? grid[iy] : undefined;
    if (row && ix >= 0 && ix < W) row[ix] = true;
  };
  const project = (lat: number, lon: number): void => {
    const x3 = Math.cos(lat) * Math.sin(lon);
    const y3 = Math.sin(lat);
    const z3 = Math.cos(lat) * Math.cos(lon);
    if (z3 < -0.05) return; // draw the front hemisphere (a hair of overlap so meridians meet the silhouette)
    set(cx + x3 * Rx, cy - y3 * Ry);
  };
  const STEPS = 120;
  const NLON = 4; // meridians — these carry the visible rotation. No parallels: at inline size they'd fill
  // the middle rows solid (hiding the rotation) — the meridians + silhouette alone read as a spinning orb.
  for (let m = 0; m < NLON; m++) {
    const lon0 = (m / NLON) * Math.PI * 2 + spin;
    for (let s = 0; s <= STEPS; s++) project((s / STEPS) * Math.PI - Math.PI / 2, lon0);
  }
  // Always-visible silhouette so the orb reads as round in every frame.
  for (let a = 0; a < 360; a++) {
    const rad = (a * Math.PI) / 180;
    set(cx + Math.cos(rad) * Rx, cy - Math.sin(rad) * Ry);
  }
  return packBraille(grid, cols, rows);
}

/** Build `frames` evenly-spaced rotation frames of a `cols`×`rows`-cell globe (each frame = an array of rows). */
export function makeGlobeFrames(cols: number, rows: number, frames: number): string[][] {
  return Array.from({ length: frames }, (_, f) =>
    globeFrame(cols, rows, (f / frames) * Math.PI * 2),
  );
}

/** How many braille cells wide the inline thinking globe is (for the ActivityLine's width accounting). */
export const INLINE_GLOBE_CELLS = 4;

/**
 * The live thinking indicator: a compact ONE-ROW, 4-cell Ambient globe that sits inline with "Thinking · 0:06".
 * 12 rotation frames — the meridians sweep across the orb as it turns. Each frame is a single braille string.
 */
export const THINKING_GLOBE: readonly string[] = makeGlobeFrames(INLINE_GLOBE_CELLS, 1, 12).map(
  (f) => f[0] ?? "",
);
