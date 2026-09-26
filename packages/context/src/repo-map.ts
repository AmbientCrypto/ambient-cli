import { readdirSync } from "node:fs";
import { dirname, extname, join, posix, relative, sep } from "node:path";
import { MAX_DIR_ENTRIES, isRealDir, readTextCappedSafe } from "./fs-safe.js";
import { estimateTokens } from "./tokens.js";

/**
 * Fleet-aware REPOSITORY MAP (Karpathy/aider pattern): give the model a ranked, token-budgeted map of the
 * codebase — file → key signatures (NOT bodies) — so it knows WHERE things are without reading everything.
 * Files are ranked by import-graph centrality (PageRank), so the most-depended-on modules come first, and the
 * map is truncated to a token budget derived from the ACTIVE model's window (small models get a smaller map).
 *
 * Dependency-free by design: symbol + import extraction is a bounded, language-aware heuristic (no native
 * tree-sitter binding to pull into a pnpm/tsup build). A tree-sitter-wasm upgrade can slot behind the same
 * `extractSymbols`/`extractImports` seam later without touching callers.
 */

const MAX_SYMBOLS_PER_FILE = 40;
const MAX_SIGNATURE_CHARS = 160;
const MAX_SCAN_FILES = 4000;
const MAX_FILE_BYTES = 131_072; // don't read a huge/minified file into the map (128 KiB)
/** Global aggregate cap on file bytes held during a scan — bounds peak memory (a big/generated tree could
 *  otherwise retain files×MAX_FILE_BYTES ≈ hundreds of MiB before parsing, on EVERY agent + subagent). */
const MAX_TOTAL_SCAN_BYTES = 20 * 1024 * 1024; // 20 MiB
/** Cap on directories visited — a pathological wide/deep tree can't stall the scan. */
const MAX_DIRS = 4000;
/** Wall-clock ceiling on the whole scan — a belt-and-suspenders bound so a HUGE or cold-cache tree (where
 *  even the capped walk of readdir/readFile is slow) can never delay the first token beyond this. Generous:
 *  a normal repo finishes in well under this; only a pathological tree ever trips it, degrading to a PARTIAL
 *  map (which is fine — the map is a ranked hint, and the model still reads files with tools). */
const MAX_SCAN_MS = 800;

/** Directories never worth mapping (build output, deps, VCS, caches). */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  "vendor",
  "target",
  ".gradle",
  ".idea",
  ".vscode",
]);

/** Extensions we extract symbols from (the map's value lives here; other files add nothing useful). */
const CODE_EXT = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".rb",
  ".php",
  ".swift",
  ".kt",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
  ".cs",
]);

const JS_TS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

/** Per-language declaration matchers — each captures a top-level signature line, NOT a nested body line. */
const SYMBOL_PATTERNS: Record<string, RegExp[]> = {
  js: [
    /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*[A-Za-z0-9_$]+\s*\(/,
    /^\s*(?:async\s+)?function\s*\*?\s*[A-Za-z0-9_$]+\s*\(/,
    /^\s*export\s+(?:abstract\s+)?class\s+[A-Za-z0-9_$]+/,
    /^\s*(?:abstract\s+)?class\s+[A-Za-z0-9_$]+/,
    /^\s*export\s+interface\s+[A-Za-z0-9_$]+/,
    /^\s*export\s+type\s+[A-Za-z0-9_$]+/,
    /^\s*export\s+enum\s+[A-Za-z0-9_$]+/,
    /^\s*export\s+const\s+[A-Za-z0-9_$]+/, // exported const (often a function/config) — a public surface
  ],
  py: [/^\s*(?:async\s+)?def\s+[A-Za-z0-9_]+\s*\(/, /^\s*class\s+[A-Za-z0-9_]+/],
  go: [/^\s*func\s+(?:\([^)]*\)\s*)?[A-Za-z0-9_]+\s*\(/, /^\s*type\s+[A-Za-z0-9_]+\s+/],
  rs: [
    /^\s*(?:pub\s+)?(?:async\s+)?fn\s+[A-Za-z0-9_]+/,
    /^\s*(?:pub\s+)?struct\s+[A-Za-z0-9_]+/,
    /^\s*(?:pub\s+)?enum\s+[A-Za-z0-9_]+/,
    /^\s*(?:pub\s+)?trait\s+[A-Za-z0-9_]+/,
  ],
};

function langOf(path: string): keyof typeof SYMBOL_PATTERNS | undefined {
  const ext = extname(path).toLowerCase();
  if (JS_TS.has(ext)) return "js";
  if (ext === ".py") return "py";
  if (ext === ".go") return "go";
  if (ext === ".rs") return "rs";
  return undefined;
}

/** One cleaned, bounded signature line (drop the body, collapse whitespace, cap length). */
function cleanSignature(line: string): string {
  const cut = line.replace(/[{]\s*$/, "").trim(); // drop a trailing `{`
  const flat = cut.replace(/\s+/g, " ").trim();
  return flat.length > MAX_SIGNATURE_CHARS ? `${flat.slice(0, MAX_SIGNATURE_CHARS - 1)}…` : flat;
}

/** Extract a bounded list of top-level signatures from a source file (language chosen by extension). */
export function extractSymbols(path: string, content: string): string[] {
  const lang = langOf(path);
  if (!lang) return [];
  const patterns = SYMBOL_PATTERNS[lang] ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of content.split("\n")) {
    if (out.length >= MAX_SYMBOLS_PER_FILE) break;
    if (raw.length > 400) continue; // a minified/huge line is not a readable signature
    if (patterns.some((re) => re.test(raw))) {
      const sig = cleanSignature(raw);
      if (sig.length > 0 && !seen.has(sig)) {
        seen.add(sig);
        out.push(sig);
      }
    }
  }
  return out;
}

const IMPORT_PATTERNS = [
  /\bimport\s+[^'"();]*?from\s*['"]([^'"]+)['"]/g, // import x from '...'
  /\bimport\s*['"]([^'"]+)['"]/g, // import '...'
  /\bexport\s+[^'"();]*?from\s*['"]([^'"]+)['"]/g, // export { x } from '...'
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // require('...')
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic import('...')
  /^\s*from\s+(\.[^\s]+)\s+import\b/gm, // python: from .x import
];

/** Extract raw import specifiers from a source file (best-effort, for the centrality graph). */
export function extractImports(_path: string, content: string): string[] {
  const out = new Set<string>();
  for (const re of IMPORT_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null = re.exec(content);
    while (m !== null) {
      if (m[1]) out.add(m[1]);
      m = re.exec(content);
    }
  }
  return [...out];
}

/** Resolve a RELATIVE import specifier to a file path that exists in `files` (bare/package specs → undefined). */
function resolveImport(fromPath: string, spec: string, files: Set<string>): string | undefined {
  if (!spec.startsWith(".")) return undefined; // only local relative imports form graph edges
  const base = posix.normalize(posix.join(posix.dirname(fromPath), spec)).replace(/\/+$/, "");
  // ESM-in-TS convention: `./x.js` on disk is `x.ts`; try the source extensions before the literal.
  const stripped = base.replace(/\.(js|jsx|mjs|cjs)$/, "");
  const candidates = [
    base,
    `${stripped}.ts`,
    `${stripped}.tsx`,
    `${stripped}.mts`,
    `${stripped}.js`,
    `${stripped}.jsx`,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
  ];
  return candidates.find((c) => files.has(c));
}

/** Standard PageRank over a directed graph (edge from → to means "from depends on to"). */
export function pageRank(
  nodes: string[],
  edges: [string, string][],
  opts: { damping?: number; iterations?: number } = {},
): Map<string, number> {
  const d = opts.damping ?? 0.85;
  const iters = opts.iterations ?? 30;
  const n = nodes.length;
  const rank = new Map<string, number>();
  if (n === 0) return rank;
  for (const node of nodes) rank.set(node, 1 / n);
  const outDeg = new Map<string, number>();
  const incoming = new Map<string, string[]>();
  for (const node of nodes) incoming.set(node, []);
  for (const [from, to] of edges) {
    if (!rank.has(from) || !rank.has(to) || from === to) continue;
    outDeg.set(from, (outDeg.get(from) ?? 0) + 1);
    incoming.get(to)?.push(from);
  }
  for (let i = 0; i < iters; i++) {
    // Dangling mass (nodes with no out-edges) is redistributed uniformly so total rank is conserved.
    let dangling = 0;
    for (const node of nodes) if ((outDeg.get(node) ?? 0) === 0) dangling += rank.get(node) ?? 0;
    const next = new Map<string, number>();
    for (const node of nodes) {
      let sum = 0;
      for (const src of incoming.get(node) ?? [])
        sum += (rank.get(src) ?? 0) / (outDeg.get(src) ?? 1);
      next.set(node, (1 - d) / n + d * (sum + dangling / n));
    }
    for (const node of nodes) rank.set(node, next.get(node) ?? 0);
  }
  return rank;
}

export interface RepoFile {
  path: string;
  content: string;
}

/** Build the ranked, token-budgeted repository map from already-read files (PURE — no fs). */
export function buildRepoMap(
  files: RepoFile[],
  opts: { tokenBudget: number; bytesPerToken?: number },
): string {
  // 1. Extract symbols + imports per file; keep only files that expose at least one signature.
  const symbolsByPath = new Map<string, string[]>();
  const importsByPath = new Map<string, string[]>();
  const allPaths = new Set(files.map((f) => f.path));
  for (const f of files) {
    const syms = extractSymbols(f.path, f.content);
    if (syms.length > 0) symbolsByPath.set(f.path, syms);
    importsByPath.set(f.path, extractImports(f.path, f.content));
  }
  const mappable = [...symbolsByPath.keys()];
  if (mappable.length === 0) return "";

  // 2. Build the dependency graph over ALL files (an unmapped util can still be a hub) and rank.
  const edges: [string, string][] = [];
  for (const f of files) {
    for (const spec of importsByPath.get(f.path) ?? []) {
      const to = resolveImport(f.path, spec, allPaths);
      if (to) edges.push([f.path, to]);
    }
  }
  const ranks = pageRank([...allPaths], edges);

  // 3. Order mappable files by centrality (tie-break: more symbols, then path) and render within budget.
  const ordered = mappable.sort((a, b) => {
    const dr = (ranks.get(b) ?? 0) - (ranks.get(a) ?? 0);
    if (Math.abs(dr) > 1e-12) return dr;
    const ds = (symbolsByPath.get(b)?.length ?? 0) - (symbolsByPath.get(a)?.length ?? 0);
    return ds !== 0 ? ds : a.localeCompare(b);
  });

  const header =
    "## Repository map (files ranked by centrality; signatures only — open a file for details)";
  const bpt = opts.bytesPerToken;
  const est = (s: string) => estimateTokens(s, bpt ? { bytesPerToken: bpt } : {});
  const FOOTER_RESERVE = 12; // keep room so the "N more files" footer never pushes us over budget
  let used = est(header);
  const blocks: string[] = [];
  let shown = 0;
  for (const path of ordered) {
    const syms = symbolsByPath.get(path) ?? [];
    const block = `${path}\n${syms.map((s) => `  ${s}`).join("\n")}`;
    const cost = est(block) + 1;
    if (used + cost + FOOTER_RESERVE > opts.tokenBudget) {
      if (shown > 0) break;
      // The highest-ranked file alone exceeds the budget — TRUNCATE its symbols to what fits (don't blow the
      // budget by "always showing one whole file"). Header-only if not even the path + one symbol fits.
      const room = opts.tokenBudget - used - FOOTER_RESERVE;
      const kept: string[] = [];
      let acc = est(path) + 1;
      for (const s of syms) {
        const c = est(`  ${s}`) + 1;
        if (acc + c > room) break;
        acc += c;
        kept.push(s);
      }
      if (kept.length === 0) break; // nothing fits → header-only
      const more = syms.length - kept.length;
      blocks.push(
        `${path}\n${kept.map((s) => `  ${s}`).join("\n")}${more > 0 ? `\n  … (${more} more)` : ""}`,
      );
      shown++;
      break; // budget spent
    }
    used += cost;
    blocks.push(block);
    shown++;
  }
  const omitted = ordered.length - shown;
  const footer = omitted > 0 ? `\n… ${omitted} more file${omitted === 1 ? "" : "s"} not shown` : "";
  return blocks.length > 0 ? `${header}\n${blocks.join("\n")}${footer}` : "";
}

/** Recursively read code files under `root` (bounded, symlink-safe), returning repo-relative posix paths.
 *  Bounded four ways — file count, total bytes, dirs visited, AND wall-clock (`deadlineMs`) — so no repo,
 *  however large or slow, can stall the scan (and thus the first token). `deadlineMs` is injectable for tests. */
export function scanWorkspace(
  root: string,
  opts: { maxFiles?: number; deadlineMs?: number } = {},
): RepoFile[] {
  const maxFiles = opts.maxFiles ?? MAX_SCAN_FILES;
  const deadline = Date.now() + (opts.deadlineMs ?? MAX_SCAN_MS);
  const out: RepoFile[] = [];
  let totalBytes = 0;
  let dirsVisited = 0;
  // Date.now() per entry is cheap; the deadline stops the walk mid-tree, yielding a partial (still-useful) map.
  const done = () =>
    out.length >= maxFiles || totalBytes >= MAX_TOTAL_SCAN_BYTES || Date.now() >= deadline;
  const walk = (dir: string, depth: number): void => {
    if (done() || depth > 12 || dirsVisited >= MAX_DIRS || !isRealDir(dir)) return;
    dirsVisited += 1;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    // Sort before the per-dir cap so WHICH entries survive the cap is deterministic (a stable map).
    for (const e of entries.sort().slice(0, MAX_DIR_ENTRIES)) {
      if (done()) return;
      if (SKIP_DIRS.has(e)) continue; // build output / deps / VCS / caches — never mapped
      const full = join(dir, e);
      if (isRealDir(full)) {
        walk(full, depth + 1);
        continue;
      }
      if (!CODE_EXT.has(extname(e).toLowerCase())) continue;
      const content = readTextCappedSafe(full, { root, maxBytes: MAX_FILE_BYTES });
      if (content === null) continue;
      totalBytes += Buffer.byteLength(content, "utf8"); // bound peak memory across the whole scan
      const rel = relative(root, full).split(sep).join("/"); // repo-relative, posix separators
      out.push({ path: rel, content });
    }
  };
  walk(root, 0);
  return out;
}

/** Scan `root` and render its ranked, token-budgeted repo map. "" when there's nothing to map. */
export function repoMap(root: string, tokenBudget: number, bytesPerToken?: number): string {
  if (tokenBudget <= 0) return "";
  const files = scanWorkspace(root);
  return buildRepoMap(files, { tokenBudget, ...(bytesPerToken ? { bytesPerToken } : {}) });
}
