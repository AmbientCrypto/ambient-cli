import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, relative } from "node:path";
import type { ToolContext, ToolDefinition } from "@amb/protocol";
import { z } from "zod";
import { killProcessTree } from "../shell.js";

/**
 * `diagnostics` — run the project's own checker (TypeScript, ESLint, Ruff, Cargo, Go) and get its errors as
 * file / line / message, instead of scraping a build log. JavaScript checkers run from the project's
 * node_modules with Node itself; native ones come from PATH (never from inside the workspace). It runs the
 * project's code, so it asks first like any command.
 */

const CHECKERS = ["tsc", "eslint", "ruff", "cargo", "go"] as const;
type Checker = (typeof CHECKERS)[number];

const Input = z.object({
  checker: z
    .enum(CHECKERS)
    .optional()
    .describe("Which checker (default: every one this project uses)"),
  path: z.string().optional().describe("Only report problems in this file or folder"),
});
const Diagnostic = z.object({
  checker: z.string(),
  file: z.string(),
  line: z.number(),
  column: z.number().optional(),
  severity: z.enum(["error", "warning"]),
  message: z.string(),
  code: z.string().optional(),
});
const Output = z.object({
  checkers: z.array(z.string()),
  diagnostics: z.array(Diagnostic),
  truncated: z.boolean(),
  /** The end of a checker's output when it failed without anything parseable. */
  notes: z.array(z.string()),
});
type Diag = z.infer<typeof Diagnostic>;

const TIMEOUT_MS = 180_000;
const MAX_DIAGNOSTICS = 200;
const MAX_OUTPUT_CHARS = 4_000_000;

/** A program on PATH outside the workspace (a cloned repo can't substitute its own). */
function onPath(name: string, workspaceRoot: string): string | undefined {
  const names = process.platform === "win32" ? [`${name}.exe`] : [name];
  for (const dir of (process.env.PATH ?? process.env.Path ?? "").split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const rel = relative(workspaceRoot, dir);
    if (!rel.startsWith("..") && !isAbsolute(rel)) continue;
    for (const n of names) {
      const p = join(dir, n);
      try {
        if (existsSync(p) && statSync(p).isFile()) return p;
      } catch {
        // unreadable PATH entry
      }
    }
  }
  return undefined;
}

interface Plan {
  checker: Checker;
  command: string;
  args: string[];
  parse: (out: string) => Diag[];
  /** Said alongside the results (what this check can't see). */
  note?: string;
}

/** tsc --pretty false: `src/a.ts(3,7): error TS2322: message` */
function parseTsc(out: string): Diag[] {
  const d: Diag[] = [];
  for (const m of out.matchAll(/^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/gm)) {
    d.push({
      checker: "tsc",
      file: (m[1] as string).replace(/\\/g, "/"),
      line: Number(m[2]),
      column: Number(m[3]),
      severity: m[4] === "warning" ? "warning" : "error",
      code: m[5] as string,
      message: m[6] as string,
    });
  }
  return d;
}

function parseEslint(out: string, root: string): Diag[] {
  let files: Array<{ filePath: string; messages: Array<Record<string, unknown>> }>;
  try {
    files = JSON.parse(out);
  } catch {
    return [];
  }
  return files.flatMap((f) =>
    f.messages.map((m) => ({
      checker: "eslint",
      file: relative(root, f.filePath).replace(/\\/g, "/"),
      line: Number(m.line ?? 0),
      column: Number(m.column ?? 0),
      severity: m.severity === 2 ? ("error" as const) : ("warning" as const),
      message: String(m.message ?? ""),
      ...(m.ruleId ? { code: String(m.ruleId) } : {}),
    })),
  );
}

function parseRuff(out: string, root: string): Diag[] {
  let items: Array<Record<string, unknown>>;
  try {
    items = JSON.parse(out);
  } catch {
    return [];
  }
  return items.map((i) => {
    const loc = (i.location ?? {}) as { row?: number; column?: number };
    return {
      checker: "ruff",
      file: relative(root, String(i.filename ?? "")).replace(/\\/g, "/"),
      line: Number(loc.row ?? 0),
      column: Number(loc.column ?? 0),
      severity: "error" as const,
      message: String(i.message ?? ""),
      ...(i.code ? { code: String(i.code) } : {}),
    };
  });
}

/** `file:line:col: error[E0425]: message` (cargo --message-format short) and `file:line:col: message` (go vet). */
function parseColonStyle(checker: Checker, out: string): Diag[] {
  const d: Diag[] = [];
  for (const m of out.matchAll(
    /^([^\s:#][^:\n]*):(\d+):(\d+): (?:(error|warning)(?:\[(\w+)\])?: )?(.*)$/gm,
  )) {
    d.push({
      checker,
      file: (m[1] as string).replace(/\\/g, "/").replace(/^\.\//, ""),
      line: Number(m[2]),
      column: Number(m[3]),
      severity: m[4] === "warning" ? "warning" : "error",
      message: m[6] as string,
      ...(m[5] ? { code: m[5] } : {}),
    });
  }
  return d;
}

/** The checkers this project uses and how to run each. */
export function detectCheckers(root: string): Plan[] {
  const plans: Plan[] = [];
  const has = (p: string) => existsSync(join(root, p));
  const tscJs = join(root, "node_modules", "typescript", "bin", "tsc");
  if (has("tsconfig.json") && existsSync(tscJs)) {
    // A "solution" tsconfig lists no files of its own, only other projects — checking it checks nothing.
    let solution = false;
    try {
      const text = readFileSync(join(root, "tsconfig.json"), "utf8");
      solution = /"references"\s*:/.test(text) && /"files"\s*:\s*\[\s*\]/.test(text);
    } catch {
      // unreadable: tsc will say so itself
    }
    plans.push({
      checker: "tsc",
      command: process.execPath,
      args: [tscJs, "--noEmit", "--pretty", "false", "-p", "."],
      parse: parseTsc,
      ...(solution
        ? {
            note: "tsc: tsconfig.json only references other projects, so this checked none of their files — run tsc -b, or check each package's own tsconfig",
          }
        : {}),
    });
  }
  const eslintJs = join(root, "node_modules", "eslint", "bin", "eslint.js");
  const eslintConfig = [
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.cjs",
    ".eslintrc",
    ".eslintrc.js",
    ".eslintrc.json",
    ".eslintrc.cjs",
  ].some(has);
  if (eslintConfig && existsSync(eslintJs)) {
    plans.push({
      checker: "eslint",
      command: process.execPath,
      args: [eslintJs, "--format", "json", "."],
      parse: (out) => parseEslint(out, root),
    });
  }
  const ruff = onPath("ruff", root);
  if (ruff && (has("ruff.toml") || has(".ruff.toml") || has("pyproject.toml"))) {
    plans.push({
      checker: "ruff",
      command: ruff,
      args: ["check", "--output-format", "json", "--exit-zero", "."],
      parse: (out) => parseRuff(out, root),
    });
  }
  const cargo = onPath("cargo", root);
  if (cargo && has("Cargo.toml")) {
    plans.push({
      checker: "cargo",
      command: cargo,
      args: ["check", "--message-format", "short", "--quiet"],
      parse: (out) => parseColonStyle("cargo", out),
    });
  }
  const go = onPath("go", root);
  if (go && has("go.mod")) {
    plans.push({
      checker: "go",
      command: go,
      args: ["vet", "./..."],
      parse: (out) => parseColonStyle("go", out),
    });
  }
  return plans;
}

function run(
  plan: Plan,
  cwd: string,
  signal: AbortSignal,
): Promise<{ out: string; code: number | null; overflow: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(plan.command, plan.args, {
      cwd,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let overflow = false;
    // Capped per chunk too: one pipe read can carry megabytes at once (Windows).
    const take = (d: Buffer) => {
      const text = d.toString("utf8");
      const room = MAX_OUTPUT_CHARS - out.length;
      if (text.length > room) overflow = true;
      if (room > 0) out += text.slice(0, room);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    const stop = () => {
      if (typeof child.pid === "number" && child.exitCode === null) killProcessTree(child.pid);
    };
    const timer = setTimeout(stop, TIMEOUT_MS);
    signal.addEventListener("abort", stop, { once: true });
    const done = (code: number | null) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      resolve({ out, code, overflow });
    };
    child.on("error", (err) => {
      out += `\n${err.message}`;
      done(null);
    });
    child.on("close", done);
  });
}

export const diagnosticsTool: ToolDefinition<z.infer<typeof Input>, z.infer<typeof Output>> = {
  manifest: {
    name: "diagnostics",
    version: "1",
    description:
      "Run this project's type checker and linters (TypeScript, ESLint, Ruff, Cargo, Go — whichever it uses) and get the problems as file / line / message. Use it after editing to check your work.",
    effects: ["process", "read"],
    idempotency: "idempotent",
    parallelSafe: false,
    resumability: "replay",
    timeoutPolicy: { idleMs: 190_000, maximumMs: 400_000 },
  },
  inputSchema: Input,
  outputSchema: Output,
  async execute(input, ctx: ToolContext) {
    const root = ctx.workspaceRoot;
    const plans = detectCheckers(root).filter((p) => !input.checker || p.checker === input.checker);
    if (plans.length === 0) {
      throw new Error(
        input.checker
          ? `this project doesn't use ${input.checker} (or it isn't installed)`
          : "found no checker this project uses (TypeScript, ESLint, Ruff, Cargo or Go, installed)",
      );
    }
    const only = input.path?.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
    const diagnostics: Diag[] = [];
    const notes: string[] = [];
    let cutShort = false;
    for (const plan of plans) {
      ctx.signal.throwIfAborted();
      const { out, code, overflow } = await run(plan, root, ctx.signal);
      const parsed = plan.parse(out);
      const found = parsed.filter((d) => !only || d.file === only || d.file.startsWith(`${only}/`));
      diagnostics.push(...found);
      if (plan.note) notes.push(plan.note);
      // Never report "clean" for output we couldn't read: too much of it, or a failure with nothing parseable.
      if (overflow) {
        cutShort = true;
        notes.push(
          `${plan.checker}: printed more than we read, so this list is incomplete — fix what's here and run it again`,
        );
      } else if (parsed.length === 0 && code !== 0) {
        notes.push(`${plan.checker}: ${out.trim().slice(-800)}`);
      }
    }
    return {
      checkers: plans.map((p) => p.checker),
      diagnostics: diagnostics.slice(0, MAX_DIAGNOSTICS),
      truncated: cutShort || diagnostics.length > MAX_DIAGNOSTICS,
      notes,
    };
  },
};
