import { declaredRecord, laneFor, resolveRecord } from "@amb/capabilities";
import type { CatalogModel, Lane } from "@amb/protocol";
import { describe, expect, it } from "vitest";
import { formatFleetRows, renderFleet } from "../src/render/fleet.js";

const m = (id: string, isReady?: boolean, extra: Partial<CatalogModel> = {}): CatalogModel => ({
  id,
  name: id,
  inputModalities: [],
  outputModalities: [],
  supportedFeatures: [],
  supportedSamplingParameters: [],
  isReady,
  ...extra,
});

// A declared-evidence lane resolver (no store) for deterministic tests.
const declaredLane = (model: CatalogModel): Lane =>
  laneFor(model, resolveRecord(model, undefined, Date.now()));

describe("formatFleetRows", () => {
  it("sorts ready → unknown → cold, then by id, and labels the evidence-based lane", () => {
    const rows = formatFleetRows(
      [
        m("b/cold", false),
        m("a/ready", true, {
          contextLength: 262144,
          supportedFeatures: ["tools"],
          inputModalities: ["text"],
        }),
        m("c/unknown", undefined),
      ],
      declaredLane,
    );
    expect(rows.map((r) => r.avail)).toEqual(["ready", "unknown", "cold"]);
    expect(rows[0]?.id).toBe("a/ready");
    expect(rows[0]?.ctx).toBe("262k");
    expect(rows[0]?.lane).toBe("direct"); // declared tools → direct
    expect(rows[0]?.vision).toBe("vision:no");
  });
});

describe("renderFleet", () => {
  it("renders a header + rows with no ANSI when color is off", () => {
    const out = renderFleet([m("vendor/one", true, { supportedFeatures: ["tools"] })], {
      color: false,
      resolveLane: declaredLane,
    });
    expect(out[0]).toContain("AMBIENT FLEET");
    expect(out.some((l) => l.includes("vendor/one") && l.includes("tools:direct"))).toBe(true);
    // No readiness labels: the catalog's flag is only a hint.
    expect(out.join("\n")).not.toMatch(/READY|COLD|ready/);
    expect(out.every((l) => !l.includes("\x1b["))).toBe(true);
  });
  it("emits ANSI when color is on", () => {
    const out = renderFleet([m("a/ready", true)], { color: true, resolveLane: declaredLane });
    expect(out.some((l) => l.includes("\x1b["))).toBe(true);
  });
});

describe("fleet display", () => {
  it("never shows money, even when the catalog carries pricing", () => {
    const out = renderFleet([m("a/ready", true, { pricing: { input: 0.5, output: 2 } })], {
      color: false,
      resolveLane: declaredLane,
    });
    expect(out.join("\n")).not.toMatch(/\$|0\.5/);
  });
  it("orders vision models the way the relay will try them", () => {
    const rows = formatFleetRows(
      [
        m("v/cold", false, { inputModalities: ["text", "image"] }),
        m("v/ready", true, { inputModalities: ["text", "image"] }),
        m("t/text", true),
      ],
      declaredLane,
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get("v/ready")?.visionRank).toBe(0);
    expect(byId.get("v/cold")?.visionRank).toBe(1);
    expect(byId.get("t/text")?.visionRank).toBeUndefined();
  });
});
