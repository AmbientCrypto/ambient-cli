import { walkFiles } from "@amb/tools-core";

/** Most paths the @ picker keeps; beyond this the tree is too big to browse and typing narrows it anyway. */
const MAX_FILES = 50_000;
/** Longest the listing may take (a launch from a huge folder must not stall anything). */
const MAX_LIST_MS = 3_000;

/**
 * The workspace's files for the `@` picker, relative with `/` separators — .gitignore'd and secret files are
 * skipped by the same walker the grep/glob tools use. Bounded in count and time.
 */
export async function listWorkspaceFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAX_LIST_MS);
  try {
    for await (const rel of walkFiles(root, { signal: controller.signal })) {
      out.push(rel);
      if (out.length >= MAX_FILES) break;
    }
  } catch {
    // an unreadable tree just means a shorter list
  } finally {
    clearTimeout(timer);
  }
  return out;
}
