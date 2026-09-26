import { describe, expect, it } from "vitest";
import { checkStartupKey } from "../src/tui/startup-key.js";

const own = { key: "sk-own-revoked-1111", source: "keychain" as const };
const shared = { key: "sk-shared-works-2222", source: "keychain-shared" as const };

describe("checkStartupKey", () => {
  it("a working key needs nothing else", async () => {
    expect(await checkStartupKey(own, [own, shared], async () => "valid")).toEqual({
      result: "valid",
    });
  });
  it("a rejected key reports (does NOT switch to) another working key", async () => {
    const r = await checkStartupKey(own, [own, shared], async (k) =>
      k === shared.key ? "valid" : "invalid",
    );
    expect(r).toEqual({ result: "invalid", alternative: shared, rejected: "keychain" });
  });
  it("no working alternative → invalid with the rejected source", async () => {
    expect(await checkStartupKey(own, [own], async () => "invalid")).toEqual({
      result: "invalid",
      rejected: "keychain",
    });
  });
});
