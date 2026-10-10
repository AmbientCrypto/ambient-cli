import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => JSON.parse(readFileSync(new URL(path, root), "utf8"));

describe("the distributed runtime contract", () => {
  it("requires a runtime supported by the renderer in source and published manifests", () => {
    const workspace = read("package.json");
    const cli = read("packages/cli/package.json");
    const published = JSON.parse(
      execFileSync(
        process.execPath,
        [fileURLToPath(new URL("scripts/npm-package-json.mjs", root))],
        { encoding: "utf8" },
      ),
    );
    expect(workspace.engines.node).toBe(">=22.0.0");
    expect(cli.engines.node).toBe(workspace.engines.node);
    expect(published.engines.node).toBe(cli.engines.node);
    expect(cli.dependencies.ink).toBe("8.0.0");
    expect(published.dependencies.ink).toBe(cli.dependencies.ink);
    expect(
      Object.values(published.dependencies).some((v) => String(v).includes("workspace:")),
    ).toBe(false);
  });
});
