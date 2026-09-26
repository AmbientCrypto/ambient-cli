import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { discoverCommands } from "../src/commands.js";

let home: string;
let ws: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "amb-cmd-home-"));
  ws = await mkdtemp(join(tmpdir(), "amb-cmd-ws-"));
  mkdirSync(join(home, ".claude", "commands"), { recursive: true });
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(ws, { recursive: true, force: true });
});
const cmd = (name: string, text: string) =>
  writeFileSync(join(home, ".claude", "commands", `${name}.md`), text);

it("uses the frontmatter description when present", () => {
  cmd("mood", "---\ndescription: Generate a design system from a mood word\n---\nbody here");
  const found = discoverCommands(ws, home).find((c) => c.name === "mood");
  expect(found?.description).toBe("Generate a design system from a mood word");
});

it("derives a real description from the body when there's no frontmatter (not 'custom command')", () => {
  // A `# Title` then a prose summary — the prose is the better description.
  cmd(
    "multi-frontend",
    "# Frontend - Frontend-Focused Development\nFrontend-focused workflow (Research → Plan → Execute), Gemini-led.\n## Usage\n/frontend <task>",
  );
  const found = discoverCommands(ws, home).find((c) => c.name === "multi-frontend");
  expect(found?.description).toBe(
    "Frontend-focused workflow (Research → Plan → Execute), Gemini-led.",
  );
});

it("falls back to the heading title when the body is only a heading", () => {
  cmd("just-title", "# Do The Thing\n$ARGUMENTS");
  const found = discoverCommands(ws, home).find((c) => c.name === "just-title");
  expect(found?.description).toBe("Do The Thing");
});

it("bounds a very long derived description", () => {
  cmd("verbose", `x${"y".repeat(200)}`);
  const found = discoverCommands(ws, home).find((c) => c.name === "verbose");
  expect(found?.description?.length ?? 0).toBeLessThanOrEqual(80);
  expect(found?.description?.endsWith("…")).toBe(true);
});
