import { join } from "node:path";
import { CapabilityStore, laneFor, learnedRecord, resolveRecord } from "@amb/capabilities";
import type { CatalogModel } from "@amb/protocol";
import { updateLearnedCeiling } from "@amb/reliability";
import type { CapabilityPort } from "@amb/runtime";
import { ambHome } from "@amb/sessions";

/** Run a persistence side effect without letting a disk failure (read-only/full FS) abort the run. */
function bestEffort(fn: () => void): void {
  try {
    fn();
  } catch {
    /* the in-memory record still holds for this run; persistence is a nice-to-have */
  }
}

/** A CapabilityStore-backed capability port: honest per-model lane + learning from real runs. */
export function makeCapabilityPort(): CapabilityPort {
  const store = new CapabilityStore(join(ambHome(), "capabilities.json"));
  // Session-scoped learned bytes/token per model (EMA), so a model that tokenizes code densely is budgeted
  // conservatively after its first response — advisory + bounded; not persisted (a within-session refinement).
  const bpt = new Map<string, number>();
  return {
    bytesPerToken(modelId: string) {
      return bpt.get(modelId);
    },
    learnBytesPerToken(modelId: string, value: number) {
      if (!(value > 1 && value < 20)) return; // ignore nonsense ratios
      const prev = bpt.get(modelId);
      bpt.set(modelId, prev === undefined ? value : prev * 0.7 + value * 0.3); // EMA, smoothed
    },
    laneFor(model: CatalogModel) {
      return laneFor(model, resolveRecord(model, store.get(model.id), Date.now()));
    },
    learn(modelId: string, worked: boolean) {
      // Preserve any learned ceiling when updating the tool-calling evidence.
      const prev = store.get(modelId);
      const rec = learnedRecord(modelId, worked, Date.now());
      bestEffort(() => store.put(prev?.ceiling ? { ...rec, ceiling: prev.ceiling } : rec));
    },
    learnedCeiling(modelId: string) {
      return store.get(modelId)?.ceiling;
    },
    learnCeiling(modelId: string, observedMax: number) {
      const prev = store.get(modelId);
      const ceiling = updateLearnedCeiling(prev?.ceiling, observedMax);
      // Keep existing tool-calling evidence; if none, a NEUTRAL record (unknown/assumed) so the ceiling
      // never pollutes lane selection. Ceilings persist longer than tool-calling evidence.
      const now = Date.now();
      const base = prev ?? {
        modelId,
        toolCalling: "unknown" as const,
        provenance: "assumed" as const,
        observedAt: now,
        expiresAt: now + 30 * 24 * 3600 * 1000,
      };
      // Best-effort persistence: a read-only/full capability store must NOT turn a recoverable overflow (which
      // triggered this learn) into an uncaught run failure.
      bestEffort(() => store.put({ ...base, ceiling }));
    },
    recordOutcome(modelId: string, ok: boolean, latencyMs: number) {
      bestEffort(() => store.recordOutcome(modelId, ok, latencyMs));
    },
    stats(modelId: string) {
      const rec = store.get(modelId);
      if (!rec?.samples) return undefined;
      return {
        samples: rec.samples,
        ...(rec.okRate !== undefined ? { okRate: rec.okRate } : {}),
        ...(rec.latencyMs !== undefined ? { latencyMs: rec.latencyMs } : {}),
      };
    },
    recordVerify(modelId: string, firstTryPass: boolean) {
      bestEffort(() => store.recordVerify(modelId, firstTryPass));
    },
    verifyStats(modelId: string) {
      const rec = store.get(modelId);
      if (!rec?.verifyRuns) return undefined;
      return { runs: rec.verifyRuns, firstTryPasses: rec.verifyFirstTryPasses ?? 0 };
    },
  };
}
