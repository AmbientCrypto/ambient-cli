import { homedir } from "node:os";
import { sep } from "node:path";
import {
  forgetNote,
  listNotes,
  memoryPath,
  rememberNote,
  rememberUserNote,
  userMemoryPath,
} from "@amb/context";

/**
 * Memory the user manages directly: `# note` saves a note to this project's memory, `/memory` shows the
 * project's and the personal (every-project) notes, `/memory all <note>` adds a personal one, and
 * `/memory forget <n>` removes one (`u<n>` for personal notes).
 */
export interface MemoryPort {
  remember(note: string): string;
  rememberEverywhere(note: string): string;
  report(): string;
  forget(which: string): string;
}

/** The note in a `# note` input: one line starting with a single `#` (a pasted markdown doc isn't a note). */
export function quickNote(input: string): string | undefined {
  const t = input.trim();
  if (!t.startsWith("#") || t.startsWith("##") || t.includes("\n")) return undefined;
  const note = t.slice(1).trim();
  return note.length > 0 ? note : undefined;
}

/** A path under the home folder as `~/…`. */
function tildePath(p: string): string {
  const home = homedir();
  return p.startsWith(`${home}${sep}`) ? `~${p.slice(home.length)}` : p;
}

export function makeMemoryPort(workspaceRoot: string, ambientHome: string): MemoryPort {
  const projectFile = memoryPath(workspaceRoot);
  const userFile = userMemoryPath(ambientHome);
  return {
    remember: (note) =>
      rememberNote(workspaceRoot, note)
        ? `Noted for this project: ${note}  (/memory to see or forget notes)`
        : "Couldn't save that note.",
    rememberEverywhere: (note) => {
      if (!note.trim()) return "usage: /memory all <note>";
      return rememberUserNote(userFile, note)
        ? `Noted for every project: ${note.trim()}`
        : "Couldn't save that note.";
    },
    report() {
      const project = listNotes(projectFile, workspaceRoot);
      const user = listNotes(userFile);
      const lines = [
        "This project (.ambient/MEMORY.md):",
        ...(project.length > 0
          ? project.map((n, i) => `  ${i + 1}. ${n}`)
          : ["  (no notes yet — start a line with # to add one)"]),
        "",
        `Every project (${tildePath(userFile)}):`,
        ...(user.length > 0
          ? user.map((n, i) => `  u${i + 1}. ${n}`)
          : ["  (none — /memory all <note> adds one)"]),
        "",
        "/memory forget <n> removes a note (u<n> for every-project notes).",
      ];
      return lines.join("\n");
    },
    forget(which) {
      const m = /^(u)?(\d+)$/i.exec(which.trim());
      if (!m?.[2]) return "usage: /memory forget <n>  (u<n> for every-project notes)";
      const gone = m[1]
        ? forgetNote(userFile, Number(m[2]))
        : forgetNote(projectFile, Number(m[2]), workspaceRoot);
      return gone ? `Forgot: ${gone}` : `There's no note ${which.trim()}.`;
    },
  };
}
