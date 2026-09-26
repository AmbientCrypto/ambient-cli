import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogModel } from "@amb/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CapabilityRecord,
  CapabilityStore,
  TTL,
  declaredRecord,
  declaredToolCalling,
  laneFor,
  learnedRecord,
  probedRecord,
  resolveRecord,
} from "../src/index.js";

const model = (over: Partial<CatalogModel> = {}): CatalogModel => ({
  id: "m/x",
  name: "x",
  inputModalities: [],
  outputModalities: [],
  supportedFeatures: [],
  supportedSamplingParameters: [],
  isReady: true,
  ...over,
});

describe("declaredToolCalling", () => {
  it("yes when a tool feature token is present", () => {
    expect(declaredToolCalling(model({ supportedFeatures: ["tools"] }))).toBe("yes");
    expect(declaredToolCalling(model({ supportedFeatures: ["function_calling"] }))).toBe("yes");
  });
  it("no when features listed but none are tool-related", () => {
    expect(declaredToolCalling(model({ supportedFeatures: ["vision"] }))).toBe("no");
  });
  it("unknown when no features listed", () => {
    expect(declaredToolCalling(model({ supportedFeatures: [] }))).toBe("unknown");
  });
});

describe("resolveRecord (provenance precedence + TTL)", () => {
  const now = 1_000_000;
  it("a fresh learned record beats the declared baseline", () => {
    const stored = learnedRecord("m/x", false, now);
    const rec = resolveRecord(model({ supportedFeatures: ["tools"] }), stored, now + 1000);
    expect(rec.provenance).toBe("learned");
    expect(rec.toolCalling).toBe("no");
  });
  it("an EXPIRED learned record is ignored → falls back to declared", () => {
    const stored = learnedRecord("m/x", false, now);
    const rec = resolveRecord(
      model({ supportedFeatures: ["tools"] }),
      stored,
      now + TTL.learned + 1,
    );
    expect(rec.provenance).toBe("declared");
    expect(rec.toolCalling).toBe("yes");
  });
  it("no stored record → declared baseline", () => {
    expect(resolveRecord(model({ supportedFeatures: ["tools"] }), undefined, now).provenance).toBe(
      "declared",
    );
  });
});

describe("laneFor", () => {
  const now = 1;
  it("a model flagged not-ready keeps its tool-calling lane (readiness is only a hint)", () => {
    expect(laneFor(model({ isReady: false }), learnedRecord("m/x", true, now))).toBe("direct");
  });
  it("proven tool-calling → direct", () => {
    expect(laneFor(model(), learnedRecord("m/x", true, now))).toBe("direct");
  });
  it("proven no tool-calling → assisted", () => {
    expect(laneFor(model(), learnedRecord("m/x", false, now))).toBe("assisted");
  });
  it("unknown → unknown", () => {
    expect(
      laneFor(
        model({ supportedFeatures: [] }),
        declaredRecord(model({ supportedFeatures: [] }), now),
      ),
    ).toBe("unknown");
  });
});

describe("CapabilityStore", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "amb-cap-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("persists and reloads records across instances", () => {
    const path = join(dir, "capabilities.json");
    const s1 = new CapabilityStore(path);
    const rec: CapabilityRecord = learnedRecord("m/x", true, 100);
    s1.put(rec);
    const s2 = new CapabilityStore(path);
    expect(s2.get("m/x")).toEqual(rec);
  });

  it("a corrupt cache file yields an empty store (no crash)", async () => {
    const path = join(dir, "capabilities.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, "{ not json");
    const s = new CapabilityStore(path);
    expect(s.all()).toEqual([]);
  });

  it("put honors provenance: a fresh PROBE can't clobber a fresh LEARNED record", () => {
    const s = new CapabilityStore(join(dir, "c.json"));
    s.put(learnedRecord("m/x", true, 1000)); // learned (rank 3), fresh
    s.put(probedRecord("m/x", false, 1001)); // probe (rank 2) must NOT overwrite the fresh learned
    expect(s.get("m/x")?.provenance).toBe("learned");
    expect(s.get("m/x")?.toolCalling).toBe("yes");
  });

  it("put allows an equal-or-stronger record (recency) and a probe over a STALE learned", () => {
    const s = new CapabilityStore(join(dir, "c.json"));
    const learnedAt = 1000;
    s.put(learnedRecord("m/x", true, learnedAt));
    // Far past the learned TTL → the learned record is stale, so a probe now replaces it.
    const probeAt = learnedAt + TTL.learned + 1;
    s.put(probedRecord("m/x", false, probeAt));
    expect(s.get("m/x")?.provenance).toBe("probed");
  });

  it("put carries a learned ceiling forward when a new record doesn't set one", () => {
    const s = new CapabilityStore(join(dir, "c.json"));
    s.put({ ...learnedRecord("m/x", true, 1000), ceiling: 120_000 });
    // A same-provenance re-observation without a ceiling must not lose the learned ceiling.
    s.put(learnedRecord("m/x", false, 1001));
    expect(s.get("m/x")?.ceiling).toBe(120_000);
    expect(s.get("m/x")?.toolCalling).toBe("no"); // the newer tool-calling signal still applies
  });

  it("recordVerify accumulates the earned-autonomy signal and survives a learn() write", () => {
    const path = join(dir, "c.json");
    const s = new CapabilityStore(path);
    s.recordVerify("m/x", true);
    s.recordVerify("m/x", false);
    s.recordVerify("m/x", true);
    expect(s.get("m/x")?.verifyRuns).toBe(3);
    expect(s.get("m/x")?.verifyFirstTryPasses).toBe(2);
    // A later tool-calling observation must NOT wipe the accumulated verify record.
    s.put(learnedRecord("m/x", true, 5000));
    expect(s.get("m/x")?.verifyRuns).toBe(3);
    expect(s.get("m/x")?.verifyFirstTryPasses).toBe(2);
    // …and it persists across instances.
    expect(new CapabilityStore(path).get("m/x")?.verifyRuns).toBe(3);
  });
});

describe("learned negative TTL", () => {
  it("a learned 'no' expires much sooner than a learned 'yes' so a demoted model is re-tested", async () => {
    const { learnedRecord, TTL } = await import("../src/index.js");
    const now = 1_000;
    expect(learnedRecord("m", false, now).expiresAt).toBe(now + TTL.learnedNo);
    expect(learnedRecord("m", true, now).expiresAt).toBe(now + TTL.learned);
    expect(TTL.learnedNo).toBeLessThan(TTL.learned);
  });
});

describe("learned request outcomes", () => {
  it("keeps a smoothed success rate and latency per model, persisted", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { CapabilityStore } = await import("../src/index.js");
    const dir = mkdtempSync(join(tmpdir(), "amb-cap-"));
    try {
      const p = join(dir, "caps.json");
      const s = new CapabilityStore(p);
      for (let i = 0; i < 5; i++) s.recordOutcome("m/x", true, 2_000);
      s.recordOutcome("m/x", false, 30_000);
      const again = new CapabilityStore(p).get("m/x");
      expect(again?.samples).toBe(6);
      expect(again?.okRate ?? 0).toBeGreaterThan(0.5);
      expect(again?.okRate ?? 1).toBeLessThan(1);
      expect(again?.latencyMs ?? 0).toBeGreaterThan(2_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("survives a tool-calling evidence write (learn → put)", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { CapabilityStore } = await import("../src/index.js");
    const dir = mkdtempSync(join(tmpdir(), "amb-cap-"));
    try {
      const s = new CapabilityStore(join(dir, "caps.json"));
      for (let i = 0; i < 3; i++) s.recordOutcome("m/x", true, 1_000);
      s.put(learnedRecord("m/x", true, Date.now()));
      const rec = s.get("m/x");
      expect(rec?.samples).toBe(3);
      expect(rec?.okRate).toBe(1);
      expect(rec?.latencyMs).toBe(1_000);
      expect(rec?.toolCalling).toBe("yes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
