import { describe, expect, it } from "vitest";
import type { FleetRow } from "../src/render/fleet.js";
import { fleetChanges } from "../src/tui/fleet-diff.js";

const r = (id: string, avail: FleetRow["avail"] = "ready"): FleetRow => ({
  id,
  avail,
  ctx: "",
  lane: "direct",
  vision: "vision:no",
});

describe("fleetChanges", () => {
  it("announces models that joined or left, not readiness flips", () => {
    expect(fleetChanges([r("a/x"), r("b/y")], [r("a/x", "cold"), r("c/new")])).toEqual([
      "new on Ambient: c/new",
      "no longer offered: b/y",
    ]);
    expect(fleetChanges([r("a/x")], [r("a/x", "cold")])).toEqual([]);
  });
  it("announces nothing when there was no earlier list to compare with", () => {
    expect(fleetChanges([], [r("a/x"), r("b/y")])).toEqual([]);
  });
});
