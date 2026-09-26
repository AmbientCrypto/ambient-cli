import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, relative } from "node:path";
import { SENSITIVE_FILE } from "./walk-files.js";

/**
 * Searching with ripgrep when it's installed: far faster than walking files in JS on a big repo, and it
 * already honours .gitignore. A copy of `rg` inside the workspace is never used (a cloned repo could ship
 * one), and anything ripgrep can't do — a regex only JavaScript understands — falls back to the JS search.
 */

/** Looked up once per PATH. */
const cache = new Map<string, string | undefined>();

/** The `rg` on PATH outside the workspace, or undefined. */
export function findRipgrep(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const pathVar = env.PATH ?? env.Path ?? "";
  if (!cache.has(pathVar)) {
    const names = process.platform === "win32" ? ["rg.exe"] : ["rg"];
    const dirs = pathVar.split(delimiter).filter((d) => d && isAbsolute(d));
    let found: string | undefined;
    for (const dir of dirs) {
      for (const n of names) {
        const p = join(dir, n);
        try {
          if (existsSync(p) && statSync(p).isFile()) {
            found = p;
            break;
          }
        } catch {
          // unreadable PATH entry
        }
      }
      if (found) break;
    }
    cache.set(pathVar, found);
  }
  const p = cache.get(pathVar);
  if (!p) return undefined;
  const rel = relative(workspaceRoot, p);
  return rel.startsWith("..") || isAbsolute(rel) ? p : undefined;
}

export interface RgMatch {
  file: string;
  line: number;
  text: string;
}

/** `*` / `?` / `[` / `{` make it a glob; otherwise it's a name suffix like `.ts`. */
export const isGlob = (g: string) => /[*?[{]/.test(g);

/**
 * Run ripgrep. Resolves to the matches, or undefined when ripgrep couldn't run this search (so the caller
 * falls back): a regex it doesn't support, or it failed to start.
 */
export function ripgrepSearch(opts: {
  rg: string;
  root: string;
  /** Where to search, relative to root with `/` ("" = everywhere). */
  start: string;
  pattern: string;
  glob?: string;
  limit: number;
  maxLineChars: number;
  denied?: (absPath: string) => boolean;
  signal: AbortSignal;
}): Promise<{ matches: RgMatch[]; truncated: boolean } | undefined> {
  const args = [
    "--json",
    "--no-config",
    "--hidden",
    "--glob",
    "!.git",
    "--max-filesize",
    "2M",
    "--max-columns",
    String(opts.maxLineChars),
    ...(opts.glob ? ["--glob", isGlob(opts.glob) ? opts.glob : `*${opts.glob}`] : []),
    "-e",
    opts.pattern,
    "--",
    opts.start || ".",
  ];
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(opts.rg, args, {
        cwd: opts.root,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolve(undefined);
      return;
    }
    const matches: RgMatch[] = [];
    let truncated = false;
    let buf = "";
    let done = false;
    const finish = (value: { matches: RgMatch[]; truncated: boolean } | undefined) => {
      if (done) return;
      done = true;
      opts.signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => {
      child.kill();
      finish({ matches, truncated: true });
    };
    opts.signal.addEventListener("abort", onAbort, { once: true });
    const take = (line: string) => {
      if (!line.startsWith('{"type":"match"')) return;
      let ev: {
        data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number };
      };
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      const file = ev.data?.path?.text?.replace(/\\/g, "/").replace(/^\.\//, "");
      const text = ev.data?.lines?.text;
      const lineNo = ev.data?.line_number;
      if (!file || typeof text !== "string" || typeof lineNo !== "number") return;
      if (opts.denied?.(join(opts.root, file))) return;
      // Secret files stay out of search results, as in the JS walk.
      if (SENSITIVE_FILE.test(file.split("/").pop() ?? "")) return;
      matches.push({ file, line: lineNo, text: text.replace(/\r?\n$/, "").slice(0, 400) });
      if (matches.length >= opts.limit) {
        truncated = true;
        child.kill();
        finish({ matches, truncated });
      }
    };
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      let nl = buf.indexOf("\n");
      while (nl !== -1 && !done) {
        take(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
      }
    });
    child.on("error", () => finish(undefined));
    child.on("close", (code) => {
      if (buf) take(buf);
      // 0 = found, 1 = nothing found; 2 = an error (often a regex ripgrep doesn't support).
      if (code === 2 && matches.length === 0) finish(undefined);
      else finish({ matches, truncated });
    });
  });
}
