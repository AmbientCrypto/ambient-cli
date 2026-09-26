import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeImageLoader } from "../src/agent/load-image.js";

// A 1×1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "amb-loadimg-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the view_image loader", () => {
  it("opens exactly the path it was given", async () => {
    writeFileSync(join(dir, "ok.png"), PNG);
    const img = await makeImageLoader("ses_loadimg1")(join(dir, "ok.png"));
    expect(img.mediaType).toBe("image/png");
  });
  it.skipIf(process.platform === "win32")(
    "never turns a checked path into a different file (escaped space → a link out)",
    async () => {
      writeFileSync(join(dir, "secret.png"), PNG);
      const ws = join(dir, "ws");
      const { mkdirSync } = await import("node:fs");
      mkdirSync(ws);
      symlinkSync(join(dir, "secret.png"), join(ws, "a b.png"));
      // `a\ b.png` doesn't exist — it must not be read as `a b.png` (the link out of the workspace).
      await expect(makeImageLoader("ses_loadimg2")(join(ws, "a\\ b.png"))).rejects.toThrow();
      await expect(makeImageLoader("ses_loadimg3")(`${join(ws, "a b.png")} `)).rejects.toThrow();
    },
  );
});
