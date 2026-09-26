import type { CatalogModel } from "@amb/protocol";
import { describe, expect, it } from "vitest";
import {
  type ChatMsg,
  DEFAULT_COMPACTION,
  budgetFromCatalog,
  buildSummaryRequest,
  compactionConfigForWindow,
  estimateTokens,
  fitInjectedBlocks,
  planCompaction,
  preflight,
  shouldCompact,
} from "../src/index.js";

const model = (over: Partial<CatalogModel> = {}): CatalogModel => ({
  id: "moonshotai/kimi-k2.7-code",
  name: "kimi",
  inputModalities: [],
  outputModalities: [],
  supportedFeatures: [],
  supportedSamplingParameters: [],
  contextLength: 262_144,
  maxOutputLength: 262_144,
  ...over,
});

describe("token estimation", () => {
  it("rounds up and never returns 0 for nonempty text", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("hello world")).toBeGreaterThan(0);
    expect(estimateTokens("x".repeat(35))).toBe(10); // 35 bytes / 3.5
  });
});

describe("budget + preflight", () => {
  it("splits shared window vs output cap and honors a learned ceiling", () => {
    const b = budgetFromCatalog(model(), 120_000);
    expect(b.contextWindow).toBe(120_000); // learned ceiling lowers it
    expect(b.outputCap).toBeLessThanOrEqual(65_536); // SAFE_MAX
  });
  it("sent output fits BOTH the output cap and window − prompt − reserve", () => {
    const b = budgetFromCatalog(model({ maxOutputLength: 8192 }));
    const p = preflight(b, {
      promptEstimate: 1000,
      requestedOutput: 100_000,
      reserve: 512,
      reasoning: true,
    });
    expect(p.sentOutput).toBe(8192); // clamped to output cap
    expect(p.overflow).toBe(false);
    expect(p.remainingShared).toBe(262_144 - 1000 - 8192);
  });
  it("toolResultCharBudget scales with the REMAINING window (compress harder as it fills)", async () => {
    const { toolResultCharBudget } = await import("../src/budget.js");
    const small = budgetFromCatalog(model({ contextLength: 32_768 }));
    const big = budgetFromCatalog(model({ contextLength: 262_144 }));
    // A small-context model gets a tighter cap than a huge one at the same (non-trivial) prompt fill.
    expect(toolResultCharBudget(small, 20_000)).toBeLessThan(toolResultCharBudget(big, 20_000));
    // Same model: the cap TIGHTENS as the prompt grows (fewer tokens remaining).
    expect(toolResultCharBudget(small, 28_000)).toBeLessThan(toolResultCharBudget(small, 4000));
    // Clamped: a nearly-full window floors at the minimum; the ceiling SCALES with the model's window.
    expect(toolResultCharBudget(small, 32_768)).toBe(1500); // MIN
    const { budgetsFor } = await import("@amb/reliability");
    expect(toolResultCharBudget(big, 0)).toBe(
      budgetsFor(262_144, big.outputCap).toolResultMaxChars,
    );
    const huge = budgetFromCatalog(model({ contextLength: 1_048_576, maxOutputLength: 65_536 }));
    expect(toolResultCharBudget(huge, 0)).toBeGreaterThan(toolResultCharBudget(big, 0));
  });

  it("flags overflow when the prompt leaves no room for the output floor", () => {
    const b = budgetFromCatalog(model({ contextLength: 4000, maxOutputLength: 4000 }));
    const p = preflight(b, {
      promptEstimate: 3990,
      requestedOutput: 2048,
      reserve: 512,
      reasoning: true,
    });
    expect(p.overflow).toBe(true);
  });
});

describe("fitInjectedBlocks (model-proportional injected context)", () => {
  it("keeps everything when the budget is ample (large model trims nothing)", () => {
    const blocks = ["AAA", "BBB", "CCC"];
    expect(fitInjectedBlocks(blocks, 100_000)).toEqual(blocks);
  });
  it("trims in PRIORITY order — later blocks dropped first when the budget is tight", () => {
    const big = "x".repeat(400); // ~114 tokens at 3.5 B/tok
    const out = fitInjectedBlocks(["INSTRUCTIONS", "MEMORY", big], 20); // room for ~1 small block
    expect(out[0]).toBe("INSTRUCTIONS"); // highest priority kept whole
    expect(out[2]).toBe(""); // lowest priority dropped
  });
  it("truncates (not drops) a block that partially fits, with a marker", () => {
    const big = "y".repeat(700);
    const out = fitInjectedBlocks([big], 60);
    expect(out[0]).toContain("trimmed to fit");
    expect((out[0] ?? "").length).toBeLessThan(big.length);
  });
  it("empty blocks pass through and don't consume budget", () => {
    expect(fitInjectedBlocks(["", "KEEP", ""], 1000)).toEqual(["", "KEEP", ""]);
  });
  it("never exceeds the budget even with multibyte content (byte-accurate trim)", () => {
    const emoji = "🌍".repeat(600); // 4 UTF-8 bytes each → a char-slice would overshoot the byte budget
    const out = fitInjectedBlocks([emoji], 50);
    const total = out.reduce((n, b) => n + estimateTokens(b), 0);
    expect(total).toBeLessThanOrEqual(50);
  });
});

describe("compactionConfigForWindow (retention scaled to the window)", () => {
  it("retention scales with the window — a 1M model keeps far more than a 262K one (no fixed ceiling)", () => {
    const big = compactionConfigForWindow(262_144);
    const huge = compactionConfigForWindow(1_048_576);
    expect(big.keepRecentTokens).toBeGreaterThan(20_000);
    expect(huge.keepRecentTokens).toBeGreaterThan(big.keepRecentTokens);
    expect(huge.reserveTokens).toBeGreaterThanOrEqual(big.reserveTokens);
    expect(big.keepRecentTokens + big.reserveTokens).toBeLessThan(262_144);
  });
  it("a small window shrinks retention so the transcript can fit (not a fixed 20k floor)", () => {
    const cfg = compactionConfigForWindow(32_000);
    expect(cfg.keepRecentTokens).toBeLessThan(20_000); // 0.35*32k = 11200
    expect(cfg.keepRecentTokens).toBeGreaterThanOrEqual(4000); // floored
    expect(cfg.reserveTokens).toBeLessThan(16_384);
    // retention (recent+reserve) must leave usable room inside the window
    expect(cfg.keepRecentTokens + cfg.reserveTokens).toBeLessThan(32_000);
  });
  it("an invalid window falls back to the base config", () => {
    expect(compactionConfigForWindow(0)).toEqual(DEFAULT_COMPACTION);
    // …which is itself sized for a conservative unknown model, so it fits the smallest assumed window.
    const d = DEFAULT_COMPACTION;
    expect(d.keepRecentTokens + d.reserveTokens).toBeLessThan(32_768);
  });
});

describe("compaction planning", () => {
  const msgs = (): ChatMsg[] => [
    { role: "system", content: "rules" },
    { role: "user", content: "GOAL: build X" },
    ...Array.from({ length: 40 }, (_, i) => ({
      role: "assistant",
      content: `step ${i} `.repeat(200),
    })),
    { role: "user", content: "recent" },
  ];

  it("shouldCompact fires past the reserve threshold", () => {
    expect(
      shouldCompact(msgs(), 5000, { reserveTokens: 1000, keepRecentTokens: 500, anchorCount: 2 }),
    ).toBe(true);
    expect(shouldCompact(msgs(), 10_000_000)).toBe(false);
  });

  it("keeps the anchor + recent window, summarizes the middle", () => {
    const plan = planCompaction(msgs(), {
      reserveTokens: 1000,
      keepRecentTokens: 2000,
      anchorCount: 2,
    });
    expect(plan.kept[0]?.content).toBe("rules");
    expect(plan.kept[1]?.content).toBe("GOAL: build X"); // anchor preserved verbatim
    expect(plan.kept.at(-1)?.content).toBe("recent");
    expect(plan.toSummarize.length).toBeGreaterThan(0);
  });

  it("never splits a tool group at the boundary", () => {
    const withGroups: ChatMsg[] = [
      { role: "system", content: "s" },
      { role: "user", content: "g" },
      { role: "assistant", content: "call", toolGroupId: "T1" },
      { role: "tool", content: "result", toolGroupId: "T1" },
      { role: "user", content: "x".repeat(200) },
    ];
    const plan = planCompaction(withGroups, {
      reserveTokens: 10,
      keepRecentTokens: 30,
      anchorCount: 2,
    });
    // The two T1 messages must be entirely on one side of the cut, never split.
    const keptT1 = plan.kept.filter((m) => m.toolGroupId === "T1").length;
    const sumT1 = plan.toSummarize.filter((m) => m.toolGroupId === "T1").length;
    expect(keptT1 === 2 || sumT1 === 2).toBe(true);
    expect(keptT1 === 1 || sumT1 === 1).toBe(false);
  });

  it("summary request carries the prior summary + skeleton sections", () => {
    const req = buildSummaryRequest([{ role: "user", content: "did a thing" }], "earlier summary");
    expect(req[0]?.content).toContain("## Goal");
    expect(req.some((m) => m.content.includes("earlier summary"))).toBe(true);
  });

  it("is PURE — never mutates the input, and preserves the caller's concrete message type", () => {
    // A richer message type (extra fields) must survive planCompaction unchanged — no widening to ChatMsg.
    type RichMsg = ChatMsg & { toolCallId?: string; tag: number };
    const input: RichMsg[] = [
      { role: "system", content: "s", tag: 0 },
      { role: "user", content: "g", tag: 1 },
      ...Array.from({ length: 20 }, (_, i) => ({
        role: "assistant",
        content: "x".repeat(200),
        tag: i + 2,
      })),
      { role: "user", content: "recent", tag: 99 },
    ];
    const snapshot = JSON.stringify(input);
    const plan = planCompaction(input, { reserveTokens: 10, keepRecentTokens: 50, anchorCount: 2 });
    // Input untouched (purity), and the concrete RichMsg type flows through (kept[0].tag is typed + present).
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(plan.kept[0]?.tag).toBe(0);
    expect(plan.toSummarize.every((m) => typeof m.tag === "number")).toBe(true);
  });
});

describe("project memory (.ambient/MEMORY.md)", () => {
  it("round-trips: write then read, under .ambient/ (never .amb/)", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { readMemory, writeMemory, memoryPath } = await import("../src/memory.js");
    const ws = await mkdtemp(join(tmpdir(), "amb-mem-"));
    try {
      expect(readMemory(ws)).toBeUndefined(); // honest empty state
      writeMemory(ws, "## Goal\nship the thing\n## Next steps\nwrite tests");
      expect(memoryPath(ws)).toContain(join(".ambient", "MEMORY.md"));
      expect(existsSync(join(ws, ".ambient", "MEMORY.md"))).toBe(true);
      const read = readMemory(ws);
      expect(read).toContain("ship the thing");
      expect(read).toContain("write tests");
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it("rememberNote compounds durable notes and writeMemory PRESERVES them", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { readMemory, writeMemory, rememberNote } = await import("../src/memory.js");
    const ws = await mkdtemp(join(tmpdir(), "amb-mem2-"));
    try {
      expect(rememberNote(ws, "the user prefers indigo")).toBe(true);
      expect(rememberNote(ws, "tests live under packages/*/test")).toBe(true);
      // A subsequent auto-summary overwrite must NOT erase the curated notes.
      writeMemory(ws, "## Goal\na new session summary");
      const read = readMemory(ws) ?? "";
      expect(read).toContain("a new session summary"); // fresh summary present
      expect(read).toContain("the user prefers indigo"); // earlier notes SURVIVE
      expect(read).toContain("tests live under packages/*/test");
      // An empty/whitespace note records nothing.
      expect(rememberNote(ws, "   ")).toBe(false);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });
});

describe("CRLF SKILL.md", () => {
  it("parses a Windows-style (CRLF) skill file like an LF one", async () => {
    const { parseSkill } = await import("../src/skills.js");
    const s = parseSkill("---\r\nname: fmt\r\ndescription: Format code\r\n---\r\nBody here\r\n");
    expect(s?.meta.name).toBe("fmt");
    expect(s?.meta.description).toBe("Format code");
  });
});
