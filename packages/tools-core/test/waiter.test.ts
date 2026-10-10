import { expect, it, vi } from "vitest";
import { waitForCondition } from "../src/waiter.js";
it("cleans up synchronous notification and subscription/check failures", async () => {
  const cleanup = vi.fn();
  expect(
    await waitForCondition(
      (check) => {
        check();
        return cleanup;
      },
      () => "exit",
      { signal: new AbortController().signal },
    ),
  ).toBe("exit");
  expect(cleanup).toHaveBeenCalledTimes(1);
  const cleanupError = vi.fn();
  await expect(
    waitForCondition(
      () => cleanupError,
      () => {
        throw Error("read failed");
      },
      { signal: new AbortController().signal },
    ),
  ).rejects.toThrow("read failed");
  expect(cleanupError).toHaveBeenCalledTimes(1);
  await expect(
    waitForCondition(
      () => {
        throw Error("subscribe failed");
      },
      () => undefined,
      { signal: new AbortController().signal },
    ),
  ).rejects.toThrow("subscribe failed");
});
