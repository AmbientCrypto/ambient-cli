import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Every test file gets its own throwaway ambient home, so session logs, history and caches written during
// tests never land in the real ~/.ambient of whoever runs them.
const home = mkdtempSync(join(tmpdir(), "amb-test-home-"));
process.env.AMB_HOME = home;
afterAll(() => rmSync(home, { recursive: true, force: true }));
