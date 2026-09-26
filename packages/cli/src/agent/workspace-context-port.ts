import {
  discoverInjectableSkills,
  folderInstructions,
  loadInstructions,
  readMemory,
  readUserMemory,
  repoMap,
  userMemoryPath,
  writeMemory,
} from "@amb/context";
import type { WorkspaceContextPort } from "@amb/runtime";
import { ambHome } from "@amb/sessions";
import { gitState } from "./git-state.js";

/**
 * The real workspace-context port: routes the runtime's fs/env reads (project instructions, durable memory,
 * clock, platform) through @amb/context + node at the CLI edge — so the runtime state machine itself stays
 * free of direct effects and remains deterministic/replayable. `now` is injectable for tests.
 */
export function makeWorkspaceContextPort(
  now: () => Date = () => new Date(),
  opts: { stableRepoMap?: boolean; userInstructions?: boolean } = {},
): WorkspaceContextPort {
  // With `stableRepoMap` (one port per interactive session) the map is built once per workspace + budget: it
  // sits in the system prompt, and rebuilding it after every edit would change the prompt and defeat the
  // provider's prompt cache. The agent's tools see the live tree regardless.
  const maps = new Map<string, string>();
  const map = (workspaceRoot: string, tokenBudget: number): string => {
    if (!opts.stableRepoMap) return repoMap(workspaceRoot, tokenBudget);
    const key = `${workspaceRoot}\0${tokenBudget}`;
    const hit = maps.get(key);
    if (hit !== undefined) return hit;
    const built = repoMap(workspaceRoot, tokenBudget);
    maps.set(key, built);
    return built;
  };
  return {
    // The user's global Claude Code / Codex instructions join only when they've opted in (claudeSettings).
    instructions: (cwd, limits) =>
      loadInstructions(cwd, limits, { userFiles: opts.userInstructions === true }).text,
    readMemory: (workspaceRoot) => readMemory(workspaceRoot),
    readUserMemory: () => readUserMemory(userMemoryPath(ambHome())),
    folderInstructions: (dir) => folderInstructions(dir),
    writeMemory: (workspaceRoot, summary) => writeMemory(workspaceRoot, summary),
    date: () => now().toISOString().slice(0, 10),
    platform: () => process.platform,
    // Only the CURATED skills auto-load into the prompt (the user's own) — the hundreds of bundled plugin +
    // Codex skills are discoverable via `ambient skills` and evocable by name, not force-fed every turn.
    skills: (workspaceRoot) => discoverInjectableSkills(workspaceRoot),
    repoMap: map,
    // Read-only git snapshot (branch / changed files / recent commits) at run start — so the agent isn't
    // blind to git without spending tool calls. Undefined outside a repo.
    git: (cwd) => gitState(cwd),
  };
}
