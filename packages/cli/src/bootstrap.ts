import { unsupportedNodeMessage } from "./runtime-check.js";

const unsupported = unsupportedNodeMessage(process.version);
if (unsupported) {
  process.stderr.write(`${unsupported}\n`);
  process.exitCode = 1;
} else {
  const entry = "./main.js";
  await import(entry).catch((error: unknown) => {
    process.stderr.write(
      `Ambient could not load: ${error instanceof Error ? error.message : String(error)}. Reinstall Ambient to restore its runtime dependencies.\n`,
    );
    process.exitCode = 1;
  });
}
