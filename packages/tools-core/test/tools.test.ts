import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { ToolContext } from "@amb/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BoundedCapture,
  applyPatchTool,
  bashTool,
  createBuiltinRegistry,
  editTool,
  globToRegExp,
  globTool,
  grepTool,
  listTool,
  readArtifactTool,
  readTool,
  rememberTool,
  resolveInWorkspace,
  toOpenAITool,
  writeTool,
} from "../src/index.js";

let ws: string;
const ctx = (): ToolContext => ({
  cwd: ws,
  workspaceRoot: ws,
  signal: new AbortController().signal,
  secret: async () => "",
  emit: () => {},
});

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "amb-tools-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe("resolveInWorkspace", () => {
  it("resolves relative paths (to the real workspace path) and blocks escapes", () => {
    const resolved = resolveInWorkspace(ws, "a.ts");
    expect(resolved.endsWith(`${sep}a.ts`)).toBe(true);
    // The returned path is inside the (realpath-resolved) workspace root.
    expect(resolved).toBe(join(realpathSync.native(ws), "a.ts"));
    expect(() => resolveInWorkspace(ws, "../evil")).toThrow();
    expect(() => resolveInWorkspace(ws, "/etc/passwd")).toThrow();
  });
  it("blocks a symlink that escapes the workspace", () => {
    // link -> /etc ; reading through it must be refused.
    symlinkSync("/etc", join(ws, "escape"));
    expect(() => resolveInWorkspace(ws, "escape/hosts")).toThrow(/symlink/);
  });
  it("blocks a DANGLING final symlink pointing outside (write-through escape)", () => {
    // link -> /tmp/outside/new (target absent). A write must not be allowed to create it (round-3 CRIT).
    symlinkSync("/tmp/amb-outside-does-not-exist/new", join(ws, "danglink"));
    expect(() => resolveInWorkspace(ws, "danglink")).toThrow(/symlink/);
  });
  it("blocks a DANGLING INTERMEDIATE symlink (escape/new.txt) — round-4", () => {
    symlinkSync("/tmp/amb-outside-nope", join(ws, "escape")); // dir target absent
    expect(() => resolveInWorkspace(ws, "escape/new.txt")).toThrow(/symlink|escapes/);
  });
  it("blocks a CHAINED symlink outer -> inner -> /outside — round-4", () => {
    symlinkSync("inner", join(ws, "outer")); // relative -> ws/inner
    symlinkSync("/tmp/amb-outside-nope2", join(ws, "inner")); // -> outside (dangling)
    expect(() => resolveInWorkspace(ws, "outer")).toThrow(/symlink|escapes/);
  });
  it("allows a symlink whose target stays INSIDE the workspace (returns canonical path)", () => {
    mkdirSync(join(ws, "real"), { recursive: true });
    symlinkSync("real", join(ws, "alias"));
    expect(resolveInWorkspace(ws, "alias")).toBe(join(realpathSync.native(ws), "real"));
  });
});

describe("read / list / glob / grep", () => {
  beforeEach(async () => {
    await writeFile(join(ws, "a.ts"), "export const x = 1;\nexport const y = 2;\n");
    await mkdir(join(ws, "sub"), { recursive: true });
    await writeFile(join(ws, "sub", "b.ts"), "import { x } from '../a';\n");
  });
  it("read returns numbered lines", async () => {
    const out = await readTool.execute({ path: "a.ts" }, ctx());
    expect(out.content).toContain("1\texport const x = 1;");
    expect(out.lines).toBe(3);
  });
  it("list skips ignores and sorts dirs first", async () => {
    const out = await listTool.execute({ path: "." }, ctx());
    expect(out.entries.map((e) => e.name)).toEqual(["sub", "a.ts"]);
  });
  it("glob matches ** patterns", async () => {
    const out = await globTool.execute({ pattern: "**/*.ts", limit: 200 }, ctx());
    expect(out.matches.sort()).toEqual(["a.ts", "sub/b.ts"]);
  });
  it("grep finds regex matches with file:line", async () => {
    const out = await grepTool.execute({ pattern: "export const", path: ".", limit: 100 }, ctx());
    expect(out.matches).toHaveLength(2);
    expect(out.matches[0]).toMatchObject({ file: "a.ts", line: 1 });
  });
  it("grep does NOT follow a symlink out of the workspace (round-3 CRIT)", async () => {
    symlinkSync("/etc/hosts", join(ws, "leak"));
    const out = await grepTool.execute({ pattern: ".", path: ".", limit: 500 }, ctx());
    // The symlink must never appear in results (its outside contents must not be read).
    expect(out.matches.some((m) => m.file === "leak")).toBe(false);
  });
  it("grep given a symlink as its START path resolves to the canonical dir, not through the link (round-4)", async () => {
    // alias -> sub (inside). grep path=alias must read sub's files under the canonical name, no escape.
    symlinkSync("sub", join(ws, "aliasdir"));
    const out = await grepTool.execute({ pattern: "import", path: "aliasdir", limit: 100 }, ctx());
    // It finds sub/b.ts's content but under the real path 'sub', never following an escaping link.
    expect(out.matches.every((m) => !m.file.startsWith("aliasdir/"))).toBe(true);
  });
});

describe("globToRegExp", () => {
  it("handles ** and *", () => {
    expect(globToRegExp("**/*.ts").test("a/b/c.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
  });
});

describe("write / edit (conflict-safe)", () => {
  it("write creates then modifies, reporting operation + hashes + diff", async () => {
    const c = await writeTool.execute({ path: "n.ts", content: "a\n" }, ctx());
    expect(c.operation).toBe("create");
    expect(c.preimageHash).toBeUndefined();
    const m = await writeTool.execute({ path: "n.ts", content: "b\n" }, ctx());
    expect(m.operation).toBe("modify");
    expect(m.diff).toContain("-a");
    expect(m.diff).toContain("+b");
  });
  it("edit replaces a unique substring and refuses on stale preimage", async () => {
    await writeFile(join(ws, "e.ts"), "const a = 1;\n");
    const out = await editTool.execute(
      { path: "e.ts", oldString: "1", newString: "2", replaceAll: false },
      ctx(),
    );
    expect(out.replacements).toBe(1);
    expect(out.operation).toBe("modify"); // carries the durable mutation op so the runtime emits file.mutation
    expect(await readFile(join(ws, "e.ts"), "utf8")).toBe("const a = 2;\n");
    await expect(
      editTool.execute(
        {
          path: "e.ts",
          oldString: "2",
          newString: "3",
          replaceAll: false,
          expectPreimageHash: "sha256:stale",
        },
        ctx(),
      ),
    ).rejects.toThrow(/changed since/);
  });
  it("checkpoints the pre-image (for rewind) before overwriting, but NOT on a fresh create", async () => {
    const saved: string[] = [];
    const cctx = (): ToolContext => ({ ...ctx(), checkpoint: (c) => saved.push(c) });
    // create: no pre-image exists → nothing checkpointed
    await writeTool.execute({ path: "c.ts", content: "v1\n" }, cctx());
    expect(saved).toEqual([]);
    // modify via write: the prior content is checkpointed
    await writeTool.execute({ path: "c.ts", content: "v2\n" }, cctx());
    expect(saved).toEqual(["v1\n"]);
    // modify via edit: the pre-edit content is checkpointed
    await editTool.execute(
      { path: "c.ts", oldString: "v2", newString: "v3", replaceAll: false },
      cctx(),
    );
    expect(saved).toEqual(["v1\n", "v2\n"]);
  });

  it("does NOT mislabel an unreadable existing path as a create", async () => {
    // A directory at the target path: readFile → EISDIR (not ENOENT). write must NOT record operation:create
    // (which would let `amb rewind` delete it) — it throws instead.
    await mkdir(join(ws, "adir"), { recursive: true });
    await expect(writeTool.execute({ path: "adir", content: "x" }, ctx())).rejects.toThrow();
  });

  it("edit refuses a non-unique oldString unless replaceAll", async () => {
    await writeFile(join(ws, "d.ts"), "x x x\n");
    await expect(
      editTool.execute({ path: "d.ts", oldString: "x", newString: "y", replaceAll: false }, ctx()),
    ).rejects.toThrow(/not unique/);
    const out = await editTool.execute(
      { path: "d.ts", oldString: "x", newString: "y", replaceAll: true },
      ctx(),
    );
    expect(out.replacements).toBe(3);
  });
});

describe("apply_patch (atomic multi-file)", () => {
  it("applies multiple hunks across files, including two hunks to the same file in sequence", async () => {
    await writeFile(join(ws, "a.ts"), "const a = 1;\nconst b = 2;\n");
    await writeFile(join(ws, "b.ts"), "export const x = 0;\n");
    const out = await applyPatchTool.execute(
      {
        edits: [
          {
            path: "a.ts",
            oldString: "const a = 1;",
            newString: "const a = 10;",
            replaceAll: false,
          },
          {
            path: "a.ts",
            oldString: "const b = 2;",
            newString: "const b = 20;",
            replaceAll: false,
          },
          { path: "b.ts", oldString: "0", newString: "42", replaceAll: false },
        ],
      },
      ctx(),
    );
    expect(out.files).toHaveLength(2);
    expect(out.edits).toBe(3);
    expect(await readFile(join(ws, "a.ts"), "utf8")).toBe("const a = 10;\nconst b = 20;\n");
    expect(await readFile(join(ws, "b.ts"), "utf8")).toBe("export const x = 42;\n");
  });

  it("two spellings of one file are one file — neither edit is lost", async () => {
    await writeFile(join(ws, "a.txt"), "1\n3\n");
    const out = await applyPatchTool.execute(
      {
        edits: [
          { path: "a.txt", oldString: "1", newString: "2", replaceAll: false },
          { path: "./a.txt", oldString: "3", newString: "4", replaceAll: false },
        ],
      },
      ctx(),
    );
    expect(out.files).toHaveLength(1);
    expect(await readFile(join(ws, "a.txt"), "utf8")).toBe("2\n4\n");
  });

  it("is ATOMIC — if ANY hunk fails to match, NOTHING is written", async () => {
    await writeFile(join(ws, "a.ts"), "keep me\n");
    await expect(
      applyPatchTool.execute(
        {
          edits: [
            { path: "a.ts", oldString: "keep me", newString: "changed", replaceAll: false },
            { path: "a.ts", oldString: "DOES NOT EXIST", newString: "x", replaceAll: false },
          ],
        },
        ctx(),
      ),
    ).rejects.toThrow(/not found/);
    // the first (valid) hunk must NOT have been written — the file is untouched
    expect(await readFile(join(ws, "a.ts"), "utf8")).toBe("keep me\n");
  });
});

describe("bash", () => {
  it("captures stdout + exit code", async () => {
    const out = await bashTool.execute({ command: "echo hello", timeoutMs: 10_000 }, ctx());
    expect(out.stdout.trim()).toBe("hello");
    expect(out.exitCode).toBe(0);
  });
  it("reports a nonzero exit code", async () => {
    const out = await bashTool.execute({ command: "exit 3", timeoutMs: 10_000 }, ctx());
    expect(out.exitCode).toBe(3);
  });
});

describe("BoundedCapture (error-biased truncation)", () => {
  it("keeps everything under the cap", () => {
    const c = new BoundedCapture(100);
    c.write("hello");
    expect(c.truncated).toBe(false);
    expect(c.text()).toBe("hello");
  });
  it("keeps head + tail and marks the dropped middle when over the cap", () => {
    const c = new BoundedCapture(10); // half=5
    c.write("AAAAA"); // fills head
    c.write("BBBBBBBBBB"); // overflow -> rolling tail keeps last 5
    expect(c.truncated).toBe(true);
    const t = c.text();
    expect(t.startsWith("AAAAA")).toBe(true);
    expect(t.endsWith("BBBBB")).toBe(true);
    expect(t).toContain("truncated");
  });
});

describe("registry + openai schema", () => {
  it("registers all builtins and exposes read-only names", () => {
    const reg = createBuiltinRegistry();
    expect(reg.list()).toHaveLength(21);
    // `plan`/`skill`/`search_skills` are read-only too (UI/reference lookups — never touch the filesystem).
    // `web_fetch`/`web_search` are NOT read-only (network); `remember` WRITES a file so it's gated too.
    // `ask_user` + `propose_goal_update` have NO effects (human interactions) so they aren't read-only either.
    expect(reg.readOnlyNames().sort()).toEqual([
      "bash_output",
      "glob",
      "grep",
      "list",
      "plan",
      "read",
      "read_artifact",
      "search_skills",
      "skill",
    ]);
  });
  it("remember tool writes a durable note to project memory", async () => {
    const out = await rememberTool.execute({ note: "use zod v4 at boundaries" }, ctx());
    expect(out.ok).toBe(true);
    const mem = await readFile(join(ws, ".ambient", "MEMORY.md"), "utf8");
    expect(mem).toContain("use zod v4 at boundaries");
    // it writes → declared as a write so plan mode blocks it and the ladder gates it (was mislabeled read).
    expect(rememberTool.manifest.effects).toEqual(["write"]);
  });
  it("read_artifact pages through an offloaded artifact via the ctx reader", async () => {
    const artifact = "LINE ".repeat(10_000); // 50k chars
    const artCtx = (): ToolContext => ({
      ...ctx(),
      readArtifact: (h) => (h === "h1" ? artifact : undefined),
    });
    const first = await readArtifactTool.execute({ handle: "h1", offset: 0, limit: 100 }, artCtx());
    expect(first.content.length).toBe(100);
    expect(first.total).toBe(artifact.length);
    expect(first.truncated).toBe(true);
    const rest = await readArtifactTool.execute({ handle: "h1", offset: 100 }, artCtx());
    expect(rest.offset).toBe(100);
    // a missing handle is an honest error, not silent empty
    await expect(readArtifactTool.execute({ handle: "nope" }, artCtx())).rejects.toThrow(
      /not found/,
    );
  });
  it("read_artifact defaults to a page that fits the model result byte cap", async () => {
    const artifact = "LINE ".repeat(10_000); // 50k chars
    const artCtx = (): ToolContext => ({ ...ctx(), readArtifact: () => artifact });
    const dflt = await readArtifactTool.execute({ handle: "h" }, artCtx());
    expect(dflt.content.length).toBeLessThanOrEqual(6_000); // modest default (was 20k → re-truncated)
    expect(dflt.truncated).toBe(true);
  });
  it("read_artifact sizes a page by SERIALIZED BYTES, not char count, for control/CJK text", async () => {
    // 10k NUL chars: JSON-escapes to 6 bytes each (\\u0000) → a naive 10k-char page serializes to ~60 KB, way
    // over the 24 KB result cap. The page must be shrunk so its serialized envelope stays under the byte budget.
    const artifact = " ".repeat(10_000);
    const artCtx = (): ToolContext => ({ ...ctx(), readArtifact: () => artifact });
    const page = await readArtifactTool.execute({ handle: "h", limit: 10_000 }, artCtx());
    const serialized = new TextEncoder().encode(JSON.stringify(page, null, 2)).length;
    expect(serialized).toBeLessThanOrEqual(16_000); // fits the byte budget…
    expect(page.content.length).toBeLessThan(10_000); // …by returning FEWER chars than requested
    expect(page.truncated).toBe(true);
  });
  it("read_artifact never splits a surrogate PAIR and always makes forward progress (/ #4)", async () => {
    const emoji = "😀"; // U+1F600 — a surrogate pair (2 UTF-16 units)
    const artifact = `${"a".repeat(9)}${emoji}${"b".repeat(20)}`; // pair straddles index 9–10
    const artCtx = (): ToolContext => ({ ...ctx(), readArtifact: () => artifact });
    // A page ending mid-pair (index 10, between the halves) EXTENDS to include the whole emoji — never a half.
    const p1 = await readArtifactTool.execute({ handle: "h", offset: 0, limit: 10 }, artCtx());
    expect(p1.content).toBe(`${"a".repeat(9)}${emoji}`);
    expect(p1.content.includes("�")).toBe(false); // no lone-surrogate replacement char
    // The next page continues past the pair — paging reconstructs the artifact losslessly.
    const p2 = await readArtifactTool.execute(
      { handle: "h", offset: p1.returned, limit: 10 },
      artCtx(),
    );
    expect(p1.content + p2.content).toBe(artifact.slice(0, p1.returned + p2.returned));
    // A caller that lands mid-pair (offset on the LOW surrogate) is snapped back to include the whole pair.
    const mid = await readArtifactTool.execute({ handle: "h", offset: 10, limit: 5 }, artCtx());
    expect(mid.offset).toBe(9);
    expect(mid.content.startsWith(emoji)).toBe(true);
    // limit:1 on a leading emoji must NOT loop forever: it returns the WHOLE pair (returned:2) and advances.
    const one = await readArtifactTool.execute(
      { handle: "e", offset: 0, limit: 1 },
      {
        ...ctx(),
        readArtifact: () => `${emoji}x`,
      },
    );
    expect(one.content).toBe(emoji);
    expect(one.returned).toBe(2); // progress: next offset is 2 = "x", not stuck on the lone half
    // Malformed UTF-16 (all LONE low surrogates) must still make progress — a lone low surrogate is NOT a pair,
    // so the start must NOT snap backward (which would return the same unit forever).
    const lows = "\udc00\udc00\udc00";
    const lowCtx = (): ToolContext => ({ ...ctx(), readArtifact: () => lows });
    const l0 = await readArtifactTool.execute({ handle: "l", offset: 0, limit: 1 }, lowCtx());
    expect(l0.returned).toBe(1);
    const l1 = await readArtifactTool.execute(
      { handle: "l", offset: l0.returned, limit: 1 },
      lowCtx(),
    );
    expect(l1.offset).toBe(1); // did NOT snap back to 0 — paging advances instead of looping
  });
  it("emits an OpenAI function tool with JSON-schema params", () => {
    const t = toOpenAITool(readTool);
    expect(t.type).toBe("function");
    expect(t.function.name).toBe("read");
    expect(t.function.parameters).toMatchObject({ type: "object" });
  });
});
