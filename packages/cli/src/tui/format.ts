/** Format a whole number of seconds as m:ss (e.g. 83 → "1:23"). Negatives clamp to 0:00. */
export function mmss(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
