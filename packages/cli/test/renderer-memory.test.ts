import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

it("renderer text caches stop retaining every streamed frame", () => {
  const require = createRequire(import.meta.url);
  const dir = dirname(require.resolve("ink"));
  const measure = pathToFileURL(join(dir, "measure-text.js")).href;
  const wrap = pathToFileURL(join(dir, "wrap-text.js")).href;
  const script = `
    const measure = (await import(${JSON.stringify(measure)})).default;
    const wrap = (await import(${JSON.stringify(wrap)})).default;
    const samples = [];
    for (let i = 0; i < 24576; i++) {
      const text = String(i) + 'x'.repeat(4096);
      measure(text); wrap(text, 80, 'wrap');
      if (i === 12287 || i === 24575) {
        global.gc(); samples.push(process.memoryUsage().heapUsed);
      }
    }
    process.stdout.write(JSON.stringify(samples));
  `;
  const [warm, final] = JSON.parse(
    execFileSync(
      process.execPath,
      ["--expose-gc", "--max-old-space-size=512", "--input-type=module", "-e", script],
      { encoding: "utf8", timeout: 55_000 },
    ),
  );
  expect(final - warm).toBeLessThan(16 * 1024 * 1024);
}, 60_000);
