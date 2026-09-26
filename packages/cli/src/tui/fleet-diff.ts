import type { FleetRow } from "../render/fleet.js";

/** Calm notices for models that joined or left the fleet since the last look (readiness flips are ignored —
 *  the catalog's readiness flag is only a hint). */
export function fleetChanges(before: readonly FleetRow[], after: readonly FleetRow[]): string[] {
  // No earlier list (the catalog couldn't be read at launch): nothing to compare against, so nothing is "new".
  if (before.length === 0) return [];
  const was = new Set(before.map((r) => r.id));
  const now = new Set(after.map((r) => r.id));
  const added = after.filter((r) => !was.has(r.id)).map((r) => r.id);
  const removed = before.filter((r) => !now.has(r.id)).map((r) => r.id);
  const out: string[] = [];
  if (added.length > 0) out.push(`new on Ambient: ${added.join(", ")}`);
  if (removed.length > 0) out.push(`no longer offered: ${removed.join(", ")}`);
  return out;
}
