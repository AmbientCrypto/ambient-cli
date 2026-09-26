import { lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { readTextCappedSafe, writeTextSafe } from "./fs-safe.js";

/**
 * Project memory — a Claude-Code-style `.ambient/MEMORY.md` at the workspace root that COMPOUNDS across
 * sessions. The agent reads it at the start of every run (durable context: goal / decisions / files / next
 * steps), and rewrites it from the structured summary whenever context is compacted. Best-effort: any I/O
 * failure is swallowed (memory is an optimization, never load-bearing).
 */

/** Ambient memory lives under `.ambient/` (matches the `ambient` command), NOT `.amb/`. */
export function memoryPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".ambient", "MEMORY.md");
}

/** Read the project memory (or undefined if none / unreadable). Symlink-safe + size-capped: MEMORY.md flows
 *  into the SYSTEM prompt, so a `.ambient/MEMORY.md` symlinked at a secret must not be followed, and a giant
 *  file must be bounded before it's read whole (fs-safe — parity with every other loader). */
export function readMemory(workspaceRoot: string): string | undefined {
  const text = readTextCappedSafe(memoryPath(workspaceRoot), { root: workspaceRoot })?.trim();
  return text && text.length > 0 ? text : undefined;
}

const MEMORY_HEADER = [
  "# Ambient memory",
  "",
  "> Auto-maintained across sessions from context compaction. The agent reads this at the start of each",
  "> run as durable project context. Treat it as notes to re-verify with tools, not ground truth.",
  "",
  "",
].join("\n");

/** The durable, model-curated section (written by the `remember` tool) — PRESERVED across the auto-summary
 *  overwrites so a deliberate note compounds across sessions instead of being erased on the next compaction. */
const NOTES_HEADER = "## Notes (curated by the agent — durable across sessions)";
const MAX_NOTES = 100;

/** Extract the curated Notes block (from its header to EOF), or "" if none. */
export function extractNotes(content: string): string {
  const i = content.indexOf(NOTES_HEADER);
  return i >= 0 ? content.slice(i).trimEnd() : "";
}

/** A memory file's text, read without following a symlink out of `root` ("" when absent). Null when it
 *  exists but can't be read safely — then it must not be rewritten either. */
function readFor(p: string, root: string): string | null {
  const text = readTextCappedSafe(p, { root });
  if (text !== null) return text;
  try {
    lstatSync(p);
    return null; // there, but a symlink / too big / unreadable
  } catch {
    return ""; // not written yet
  }
}

/**
 * Rewrite the auto-summary portion of project memory from the latest structured summary, PRESERVING the
 * curated Notes section (writeMemory used to blank-overwrite, erasing deliberate notes). Best-effort.
 */
export function writeMemory(workspaceRoot: string, summary: string): void {
  const body = summary.trim();
  if (body.length === 0) return;
  const p = memoryPath(workspaceRoot);
  const existing = readFor(p, workspaceRoot);
  if (existing === null) return; // best-effort — memory is never load-bearing
  const notes = extractNotes(existing);
  writeTextSafe(p, `${MEMORY_HEADER}${body}\n${notes ? `\n${notes}\n` : ""}`, {
    root: workspaceRoot,
  });
}

/**
 * Append a deliberate durable note to the curated Notes section (the `remember` tool). Merge-preserving: it
 * keeps the auto-summary above and the last MAX_NOTES bullets, so notes compound across sessions and can't
 * be wiped by the next compaction's writeMemory. Bounded + best-effort. Returns whether it recorded anything.
 */
export function rememberNote(workspaceRoot: string, note: string): boolean {
  return appendNote(memoryPath(workspaceRoot), note, MEMORY_HEADER, workspaceRoot);
}

function appendNote(p: string, note: string, header: string, root: string): boolean {
  const clean = note.replace(/\s+/g, " ").trim().slice(0, 500);
  if (clean.length === 0) return false;
  try {
    const existing = readFor(p, root);
    if (existing === null) return false;
    const idx = existing.indexOf(NOTES_HEADER);
    const above = (idx >= 0 ? existing.slice(0, idx) : existing).trimEnd();
    const priorBullets = (idx >= 0 ? existing.slice(idx) : "")
      .split("\n")
      .filter((l) => l.startsWith("- "));
    const bullets = [...priorBullets, `- ${clean}`].slice(-MAX_NOTES);
    const head = above.length > 0 ? above : header.trimEnd();
    return writeTextSafe(p, `${head}\n\n${NOTES_HEADER}\n${bullets.join("\n")}\n`, { root });
  } catch {
    return false; // best-effort — memory is never load-bearing
  }
}

/** The notes (bullets) in a memory file's curated Notes section, in order (`root`: the folder the file must
 *  stay inside — the workspace for a project's memory). */
export function listNotes(file: string, root = dirname(file)): string[] {
  try {
    const text = readFor(file, root) ?? "";
    const idx = text.indexOf(NOTES_HEADER);
    if (idx < 0) return [];
    return text
      .slice(idx)
      .split("\n")
      .filter((l) => l.startsWith("- "))
      .map((l) => l.slice(2));
  } catch {
    return [];
  }
}

/** Remove note `n` (1-based) from a memory file's Notes section; returns the removed note, if any. */
export function forgetNote(file: string, n: number, root = dirname(file)): string | undefined {
  try {
    const text = readFor(file, root);
    if (!text) return undefined;
    const idx = text.indexOf(NOTES_HEADER);
    if (idx < 0) return undefined;
    const above = text.slice(0, idx).trimEnd();
    const bullets = text
      .slice(idx)
      .split("\n")
      .filter((l) => l.startsWith("- "));
    const gone = bullets[n - 1];
    if (gone === undefined) return undefined;
    const rest = bullets.filter((_, i) => i !== n - 1);
    const notes = rest.length > 0 ? `${NOTES_HEADER}\n${rest.join("\n")}\n` : "";
    return writeTextSafe(file, `${above}\n${notes ? `\n${notes}` : ""}`, { root })
      ? gone.slice(2)
      : undefined;
  } catch {
    return undefined;
  }
}

/** The file for notes that apply to every project (under ambient's home folder). */
export function userMemoryPath(ambientHome: string): string {
  return join(ambientHome, "MEMORY.md");
}

/** Add a note that applies to every project. */
export function rememberUserNote(file: string, note: string): boolean {
  return appendNote(file, note, USER_MEMORY_HEADER, dirname(file));
}

/** The notes that apply to every project, as prompt text (undefined when there are none). */
export function readUserMemory(file: string): string | undefined {
  const notes = listNotes(file);
  return notes.length > 0 ? notes.map((n) => `- ${n}`).join("\n") : undefined;
}

const USER_MEMORY_HEADER = [
  "# Ambient memory — every project",
  "",
  "> Notes you asked ambient to keep for all your projects (/memory to see or forget them).",
  "",
  "",
].join("\n");
