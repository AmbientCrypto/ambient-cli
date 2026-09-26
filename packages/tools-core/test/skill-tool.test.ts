import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@amb/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { skillTool } from "../src/tools/skill.js";

function ctx(workspaceRoot: string): ToolContext {
  return {
    cwd: workspaceRoot,
    workspaceRoot,
    signal: new AbortController().signal,
    secret: async () => "",
    emit: () => {},
    scope: { sessionId: "ses_x", turnId: "trn_x", attemptId: "att_x" },
  };
}

const writeSkill = (dir: string, name: string, body: string) => {
  const d = join(dir, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}`,
  );
  return d;
};

let ws: string;
let fakeHome: string;
let realProfile: string | undefined;
let realHome: string | undefined;

beforeEach(() => {
  // realpath: on macOS tmpdir() is a /var → /private/var symlink; read/list realpath the root, so a canonical
  // ws mirrors a real user workspace (where the dir hint fires) instead of the symlink edge.
  ws = realpathSync(mkdtempSync(join(tmpdir(), "amb-skilltool-ws-")));
  // Isolate HOME so ~/.claude/skills resolves into a temp dir (never the real one) — and so an
  // out-of-workspace skill can be planted for the honesty test below.
  fakeHome = realpathSync(mkdtempSync(join(tmpdir(), "amb-skilltool-home-")));
  realHome = process.env.HOME;
  realProfile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome; // os.homedir() reads USERPROFILE on Windows
});
afterEach(() => {
  if (realProfile === undefined) Reflect.deleteProperty(process.env, "USERPROFILE");
  else process.env.USERPROFILE = realProfile;
  if (realHome === undefined) process.env.HOME = "";
  else process.env.HOME = realHome;
  rmSync(ws, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("skill tool — bundled-files dir hint is HONEST (only when read/list can actually open it)", () => {
  it("surfaces the skill dir for a WORKSPACE-LOCAL skill (read/list can reach it)", async () => {
    const dir = writeSkill(join(ws, ".ambient", "skills"), "deploy", "run make release");
    const res = await skillTool.execute({ name: "deploy" }, ctx(ws));
    expect(res.found).toBe(true);
    expect(res.body).toContain("run make release"); // the instructions
    expect(res.body).toContain("This skill's files are in:"); // the hint fires…
    expect(res.body).toContain(dir); // …and points at the real, reachable dir
  });

  it("does NOT claim readability for an OUT-OF-WORKSPACE skill (~/.claude/skills) — that would be a lie", async () => {
    // Planted under HOME (~/.claude/skills), which the workspace-scoped read/list tools REFUSE.
    writeSkill(join(fakeHome, ".claude", "skills"), "homeskill", "do the thing");
    const res = await skillTool.execute({ name: "homeskill" }, ctx(ws));
    expect(res.found).toBe(true);
    expect(res.body).toContain("do the thing"); // the instructions still load…
    expect(res.body).not.toContain("This skill's files are in:"); // …but NO false "read from that dir" hint
  });
});

describe("a skill installed outside the project", () => {
  it("loading it lets read/list open its own files for the run — nothing else outside the workspace", async () => {
    const dir = writeSkill(join(fakeHome, ".claude", "skills"), "pdf", "run scripts/extract.py");
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "scripts", "extract.py"), "print('extract')");
    writeFileSync(join(fakeHome, "secret.txt"), "NOT-FOR-THE-MODEL");
    const roots = new Set<string>();
    const c: ToolContext = {
      ...ctx(ws),
      readRoots: { list: () => [...roots], add: (d) => void roots.add(d) },
    };
    const { readTool } = await import("../src/tools/read.js");
    const { listTool } = await import("../src/tools/list.js");
    await expect(readTool.execute({ path: join(dir, "scripts", "extract.py") }, c)).rejects.toThrow(
      /escapes/,
    );

    const res = await skillTool.execute({ name: "pdf" }, c);
    expect(res.body).toContain(`This skill's files are in: ${dir}`);
    const file = await readTool.execute({ path: join(dir, "scripts", "extract.py") }, c);
    expect(file.content).toContain("print('extract')");
    const listing = await listTool.execute({ path: dir }, c);
    expect(JSON.stringify(listing)).toContain("scripts");

    await expect(readTool.execute({ path: join(fakeHome, "secret.txt") }, c)).rejects.toThrow(
      /escapes/,
    );
    await expect(
      readTool.execute({ path: join(dir, "..", "..", "..", "secret.txt") }, c),
    ).rejects.toThrow();
  });
});
