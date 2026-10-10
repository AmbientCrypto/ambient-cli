import { expect, it } from "vitest";
import { unsupportedNodeMessage } from "../src/runtime-check.js";

it("rejects unsupported runtimes before renderer dependencies are loaded", () => {
  expect(unsupportedNodeMessage("20.19.6")).toContain("Node 22+");
  expect(unsupportedNodeMessage("20.19.6")).toContain("20.19.6");
  expect(unsupportedNodeMessage("22.0.0")).toBeUndefined();
  expect(unsupportedNodeMessage("24.1.0")).toBeUndefined();
  expect(unsupportedNodeMessage("26.10.0")).toBeUndefined();
  expect(unsupportedNodeMessage("invalid")).toContain("Node 22+");
});
