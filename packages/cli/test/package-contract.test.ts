import { expect, it } from "vitest";

it("rejects a stale release lock and undeclared runtime imports", async () => {
  const url = new URL("../../../scripts/package-contract.mjs", import.meta.url).href;
  const { verifyReleaseLock, verifyExternals } = await import(url);
  const pkg = {
    name: "ambient-code",
    version: "1.0.4",
    engines: { node: ">=22.0.0" },
    dependencies: { ink: "8.0.0" },
  };
  const lock = {
    name: pkg.name,
    version: pkg.version,
    packages: { "": pkg, "node_modules/ink": { version: "8.0.0", integrity: "sha512-test" } },
  };
  expect(() => verifyReleaseLock(pkg, lock)).not.toThrow();
  expect(() => verifyReleaseLock(pkg, { ...lock, version: "1.0.3" })).toThrow(/stale/);
  expect(() =>
    verifyReleaseLock(pkg, {
      ...lock,
      packages: { ...lock.packages, "": { ...pkg, dependencies: {} } },
    }),
  ).toThrow(/dependencies/);
  expect(() =>
    verifyExternals(pkg, {
      outputs: { "dist/main.js": { imports: [{ path: "yaml", external: true }] } },
    }),
  ).toThrow(/yaml/);
  expect(() =>
    verifyExternals(pkg, {
      outputs: {
        "dist/main.js": {
          imports: [
            { path: "ink", external: true },
            { path: "node:fs", external: true },
            { path: "./chunk.js", external: true },
          ],
        },
      },
    }),
  ).not.toThrow();
});
