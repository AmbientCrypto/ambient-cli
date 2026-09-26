import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { type CapabilityRecord, PROVENANCE_RANK, isFresh } from "./evidence.js";

/**
 * A small JSON-file cache of capability records, keyed by model id. Atomic writes (temp→rename).
 * The store is best-effort: a corrupt or missing file yields an empty store rather than crashing.
 */

const RecordSchema = z.object({
  modelId: z.string(),
  toolCalling: z.enum(["yes", "no", "unknown"]),
  provenance: z.enum(["learned", "probed", "declared", "assumed"]),
  observedAt: z.number(),
  expiresAt: z.number(),
  ceiling: z.number().int().positive().optional(),
  verifyRuns: z.number().int().nonnegative().optional(),
  verifyFirstTryPasses: z.number().int().nonnegative().optional(),
  okRate: z.number().min(0).max(1).optional(),
  latencyMs: z.number().nonnegative().optional(),
  samples: z.number().int().nonnegative().optional(),
});
const FileSchema = z.object({ version: z.literal(1), records: z.record(z.string(), RecordSchema) });

export class CapabilityStore {
  private records = new Map<string, CapabilityRecord>();

  constructor(private readonly path: string) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const parsed = FileSchema.parse(JSON.parse(readFileSync(this.path, "utf8")));
      for (const [id, rec] of Object.entries(parsed.records)) this.records.set(id, rec);
    } catch {
      // corrupt cache — start empty (it's just an optimization, safe to rebuild)
    }
  }

  get(modelId: string): CapabilityRecord | undefined {
    return this.records.get(modelId);
  }

  /**
   * Upsert a record, honoring the provenance hierarchy (learned > probed > declared > assumed): a WEAKER,
   * still-FRESH existing record is NOT clobbered by a lower-provenance write (e.g. a probe can't overwrite a
   * fresh learned observation). Equal-or-stronger provenance replaces (recency wins). A learned ceiling is
   * carried forward when the incoming record doesn't set one (ceilings outlive tool-calling evidence).
   */
  put(rec: CapabilityRecord): void {
    const existing = this.records.get(rec.modelId);
    if (
      existing &&
      isFresh(existing, rec.observedAt) &&
      PROVENANCE_RANK[existing.provenance] > PROVENANCE_RANK[rec.provenance]
    ) {
      return; // keep the stronger, still-fresh evidence
    }
    // Sticky fields (ceiling, verify stats, request outcomes) outlive tool-calling evidence — carry them forward when the
    // incoming record doesn't set them, so a `learn()` write never wipes a model's earned-autonomy record.
    const merged: CapabilityRecord = {
      ...rec,
      ceiling: rec.ceiling ?? existing?.ceiling,
      verifyRuns: rec.verifyRuns ?? existing?.verifyRuns,
      verifyFirstTryPasses: rec.verifyFirstTryPasses ?? existing?.verifyFirstTryPasses,
      okRate: rec.okRate ?? existing?.okRate,
      latencyMs: rec.latencyMs ?? existing?.latencyMs,
      samples: rec.samples ?? existing?.samples,
    };
    this.records.set(rec.modelId, merged);
    this.persist();
  }

  /** Record one verify-gate outcome for a model (its earned-autonomy signal). Not provenance-gated. */
  recordVerify(modelId: string, firstTryPass: boolean): void {
    const now = Date.now();
    const existing = this.records.get(modelId);
    const base: CapabilityRecord = existing ?? {
      modelId,
      toolCalling: "unknown",
      provenance: "assumed",
      observedAt: now,
      expiresAt: now + 90 * 24 * 3600 * 1000, // verify trust is slow-earned; keep it ~90 days
    };
    this.records.set(modelId, {
      ...base,
      verifyRuns: (base.verifyRuns ?? 0) + 1,
      verifyFirstTryPasses: (base.verifyFirstTryPasses ?? 0) + (firstTryPass ? 1 : 0),
    });
    this.persist();
  }

  /**
   * Fold one real request outcome into the model's smoothed success rate and latency (an exponential moving
   * average, so recent behavior counts most). Used to steer automatic model choice away from a model that
   * keeps failing or stalling. Best-effort.
   */
  recordOutcome(modelId: string, ok: boolean, latencyMs: number): void {
    const now = Date.now();
    const existing = this.records.get(modelId);
    const base: CapabilityRecord = existing ?? {
      modelId,
      toolCalling: "unknown",
      provenance: "assumed",
      observedAt: now,
      expiresAt: now + 30 * 24 * 3600 * 1000,
    };
    const a = 0.2;
    const samples = (base.samples ?? 0) + 1;
    this.records.set(modelId, {
      ...base,
      samples,
      okRate: base.okRate === undefined ? (ok ? 1 : 0) : base.okRate * (1 - a) + (ok ? 1 : 0) * a,
      latencyMs:
        base.latencyMs === undefined
          ? latencyMs
          : base.latencyMs * (1 - a) + Math.max(0, latencyMs) * a,
    });
    this.persist();
  }

  all(): CapabilityRecord[] {
    return [...this.records.values()];
  }

  private persist(): void {
    const obj: Record<string, CapabilityRecord> = {};
    for (const [id, rec] of this.records) obj[id] = rec;
    const data = JSON.stringify({ version: 1, records: obj }, null, 2);
    mkdirSync(dirname(this.path), { recursive: true });
    // A unique temp name so two ambient processes can't clobber each other's write; the rename is retried
    // briefly because Windows refuses it while an antivirus or indexer holds the target open.
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, data, "utf8");
    renameWithRetry(tmp, this.path);
  }
}

/** rename(), retried a few times on the transient EPERM/EBUSY/EACCES Windows returns while a file is held. */
export function renameWithRetry(from: string, to: string, attempts = 5): void {
  for (let i = 0; ; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= attempts - 1 || !["EPERM", "EBUSY", "EACCES"].includes(code ?? "")) {
        rmSync(from, { force: true });
        throw e;
      }
      const until = Date.now() + 20 * (i + 1);
      while (Date.now() < until) {
        // brief synchronous back-off (persist() is synchronous by design)
      }
    }
  }
}
