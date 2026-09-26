import {
  discoverInjectableSkills,
  discoverSkills,
  loadSkillBody,
  pinSkill,
  readPinnedSkills,
  skillSource,
  unpinSkill,
} from "@amb/context";
import { add, bold, cyan, dim } from "../render/color.js";

const ROOTS_HELP =
  ".ambient/skills · .claude/skills · ~/.claude/skills · ~/.claude/plugins/**/skills · ~/.codex/skills";

/**
 * `ambient skills [--json]` — scrape every skill the agent can use (Ambient's own + your existing Claude
 * skills, installed Claude plugins, and Codex skills) and list them, marking which are PINNED (always load).
 * `ambient skills show "<name>"` prints one skill's full instructions. `ambient skills pin/unpin "<name>"`
 * manages the always-load list. Skills auto-load as a lightweight catalog budgeted to the served model's
 * window; the agent pulls a skill's body on demand — or you can name any skill in your prompt to steer it.
 */
export async function runSkills(args: string[]): Promise<void> {
  const cwd = process.cwd();
  const [sub, ...rest] = args;
  const nameArg = () =>
    rest
      .filter((a) => !a.startsWith("-"))
      .join(" ")
      .trim();

  if (sub === "show") {
    const name = nameArg();
    if (!name) {
      process.stderr.write('usage: ambient skills show "<name>"\n');
      process.exitCode = 1;
      return;
    }
    const body = loadSkillBody(cwd, name);
    if (body === undefined) {
      process.stderr.write(
        `ambient: no skill named "${name}" — run 'ambient skills' to see what's available.\n`,
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${body}\n`);
    return;
  }

  if (sub === "pin" || sub === "unpin") {
    const name = nameArg();
    if (!name) {
      process.stderr.write(`usage: ambient skills ${sub} "<name>"\n`);
      process.exitCode = 1;
      return;
    }
    if (sub === "pin") {
      // Pin any discovered skill — even a plugin/Codex one — so it ALWAYS auto-loads (survives the window budget).
      if (loadSkillBody(cwd, name) === undefined) {
        process.stderr.write(
          `ambient: no skill named "${name}" to pin — run 'ambient skills' to see the names.\n`,
        );
        process.exitCode = 1;
        return;
      }
      process.stdout.write(
        pinSkill(name)
          ? `${add("✓")} pinned ${cyan(name)} — it will always auto-load into the prompt.\n`
          : dim(`"${name}" was already pinned.\n`),
      );
    } else {
      process.stdout.write(
        unpinSkill(name)
          ? `${add("✓")} unpinned ${cyan(name)}.\n`
          : dim(`"${name}" was not pinned.\n`),
      );
    }
    return;
  }

  const json = args.includes("--json");
  const skills = discoverSkills(cwd);
  const pinned = new Set(readPinnedSkills(cwd));
  const injectable = new Set(discoverInjectableSkills(cwd).map((s) => s.name));

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        skills.map((s) => ({
          name: s.name,
          description: s.description,
          source: skillSource(s.path),
          pinned: pinned.has(s.name),
          autoLoads: injectable.has(s.name),
          path: s.path,
        })),
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (skills.length === 0) {
    process.stdout.write(
      `No skills found.\n\nAmbient auto-loads skills from:\n  ${dim(ROOTS_HELP)}\n`,
    );
    return;
  }

  const rows = skills
    .map((s) => ({
      name: s.name,
      source: skillSource(s.path),
      desc: s.description,
      pinned: pinned.has(s.name),
    }))
    // pinned first, then by source + name
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        a.source.localeCompare(b.source) ||
        a.name.localeCompare(b.name),
    );
  const nameW = Math.min(38, Math.max(4, ...rows.map((r) => r.name.length)));
  const srcW = Math.max(...rows.map((r) => r.source.length));

  process.stdout.write(
    `${bold(`AMBIENT SKILLS — ${skills.length} discovered`)}${dim(" (Claude + Codex + plugins)")}\n` +
      `${dim(`  up to ${injectable.size} auto-load into the prompt (budgeted to the model's window)${pinned.size ? ` · ${pinned.size} pinned (always)` : ""} · name any to evoke it`)}\n\n`,
  );
  for (const r of rows) {
    const desc = r.desc.replace(/\s+/g, " ").trim();
    const shown = desc.length > 82 ? `${desc.slice(0, 81)}…` : desc;
    const mark = r.pinned ? cyan("◆ ") : "  "; // ◆ = pinned (always auto-loads)
    process.stdout.write(
      `${mark}${cyan(r.name.padEnd(nameW))}  ${dim(`[${r.source.padEnd(srcW)}]`)}  ${dim(shown)}\n`,
    );
  }
  process.stdout.write(
    `\n${dim("Pin a favorite so it always loads:  ")}ambient skills pin "<name>"\n` +
      `${dim("Use any skill right now:            ")}${cyan(`ambient "use the ${rows[0]?.name ?? "<name>"} skill to …"`)}\n` +
      `${dim("Inspect one:                        ")}ambient skills show "<name>"\n`,
  );
}
