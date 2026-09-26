import { describe, expect, it } from "vitest";
import { probeCallValid } from "../src/commands/probe.js";

describe("the tool-calling probe", () => {
  it("counts only a call that carries the declared argument", () => {
    expect(probeCallValid('{"sum":42}')).toBe(true);
    expect(probeCallValid('{"sum":"42"}')).toBe(false);
    expect(probeCallValid("null")).toBe(false);
    expect(probeCallValid('{"wrong":1}')).toBe(false);
    expect(probeCallValid('{"sum":4.2}')).toBe(false);
    expect(probeCallValid("[42]")).toBe(false);
    expect(probeCallValid("not json")).toBe(false);
  });
});
