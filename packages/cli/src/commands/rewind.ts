import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { contentHash, planRewind, readObject, readSession } from "@amb/sessions";
import { resolveInWorkspace } from "@amb/tools-core";
import { resolveSessionId } from "../agent/session-select.js";
import { bold, dim } from "../render/color.js";

const KNOWN_FLAGS = new Set(["--yes", "-y", "--force"]);

/**
 * `amb rewind [<id|latest>] [N] [--yes] [--force]` — revert the workspace to the state before the last N
 * file-changing turns of a session, restoring each file from its checkpointed pre-image. DRY-RUN by default;
 * `--yes` applies. SAFE by construction: refuses a corrupt OR torn log, resolves against the session's
 * recorded workspaceRoot (never the caller cwd), conflict-checks current content against the recorded
 * post-image so later user edits aren't clobbered (`--force` overrides ONLY the content conflict, never the
 * workspace boundary), and NEVER follows a final symlink (restore skips it; delete unlinks the link itself).
 */
export async function runRewind(argv: string[]): Promise<void> {
  const badFlag = argv.find((a) => a.startsWith("-") && !KNOWN_FLAGS.has(a));
  if (badFlag) {
    process.stderr.write(`ambient: unknown option ${badFlag}\n`);
    process.exitCode = 1;
    return;
  }
  const apply = argv.includes("--yes") || argv.includes("-y");
  const force = argv.includes("--force");
  const positional = argv.filter((a) => !a.startsWith("-"));
  let idArg = "latest";
  let turns = 1;
  for (const p of positional) {
    if (/^\d+$/.test(p)) turns = Number.parseInt(p, 10);
    else idArg = p;
  }
  if (!Number.isSafeInteger(turns) || turns < 1) {
    process.stderr.write("ambient: rewind N must be a positive integer\n");
    process.exitCode = 1;
    return;
  }

  const sid = resolveSessionId(idArg);
  if (!sid) {
    process.stderr.write("ambient: no session found to rewind\n");
    process.exitCode = 1;
    return;
  }
  const { events, chainIntact, droppedTail } = readSession(sid);
  if (!chainIntact || droppedTail !== 0) {
    // A torn tail means the LAST mutation may be missing → the rewind window would be wrong.
    process.stderr.write(
      `ambient: session ${sid} has a corrupted or torn log — refusing to rewind it\n`,
    );
    process.exitCode = 1;
    return;
  }
  const root = events.find((e) => e.kind === "session.started")?.workspaceRoot;
  if (!root) {
    process.stderr.write(`ambient: session ${sid} has no recorded workspace root — refusing\n`);
    process.exitCode = 1;
    return;
  }

  const plan = planRewind(events, turns);
  if (plan.restores.length === 0) {
    process.stdout.write(dim(`nothing to rewind in ${sid} (no file changes)\n`));
    return;
  }

  process.stdout.write(
    `${bold("amb rewind")} ${dim(`· ${sid} · undoing ${plan.undoneTurnCount} turn(s)`)}\n`,
  );
  for (const r of plan.restores) {
    const label =
      r.action === "delete" ? dim("delete ") : r.action === "restore" ? "restore" : dim("skip   ");
    process.stdout.write(
      `  ${label} ${r.path}${r.action === "unrestorable" ? dim(" (no checkpoint)") : ""}\n`,
    );
  }
  if (!apply) {
    process.stdout.write(dim("\n(dry run — re-run with --yes to apply)\n"));
    return;
  }

  let restored = 0;
  let deleted = 0;
  let skipped = 0;
  const warn = (m: string) => {
    process.stderr.write(dim(`  ⚠ ${m}\n`));
    skipped++;
  };
  for (const r of plan.restores) {
    // A single bad entry (a path turned into a directory, an escaping parent symlink, …) must NOT abort the
    // whole rewind — isolate each entry so the rest still apply.
    try {
      if (r.action === "unrestorable") {
        skipped++;
        continue;
      }
      // Resolve the PARENT within the workspace (guards escapes); operate on the final component literally so
      // we never follow a swapped-in final symlink.
      const parent = resolveInWorkspace(root, dirname(r.path) || ".");
      const target = join(parent, basename(r.path));
      const link = lstatSafe(target);

      // A final-component symlink is NEVER followed — restoring THROUGH it could write outside the workspace
      // (critical), so we refuse it regardless of --force (that only overrides a content conflict).
      if (r.action === "restore" && link?.isSymbolicLink()) {
        warn(`${r.path} is now a symlink — skipped`);
        continue;
      }

      if (!force) {
        if (link?.isSymbolicLink()) {
          warn(`${r.path} is now a symlink — skipped (use --force)`);
          continue;
        }
        const nowHash = existsSync(target) ? contentHash(readFileSync(target, "utf8")) : "absent";
        if (r.expectedNowHash !== undefined && nowHash !== r.expectedNowHash) {
          warn(`${r.path} changed since the session — skipped (use --force)`);
          continue;
        }
      }

      if (r.action === "delete") {
        if (link || existsSync(target)) {
          unlinkSync(target); // unlink the final component itself, never its symlink target
          deleted++;
        }
        continue;
      }
      const content = readObject(sid, r.hashKey as string);
      if (content === undefined) {
        warn(`no intact checkpoint for ${r.path} — left unchanged`);
        continue;
      }
      mkdirSync(parent, { recursive: true });
      writeFileSync(target, content, "utf8");
      restored++;
    } catch (e) {
      warn(`${r.path}: ${(e as Error).message}`);
    }
  }
  const tail = skipped > 0 ? `, ${skipped} skipped` : "";
  process.stdout.write(`✓ restored ${restored}, deleted ${deleted}${tail}\n`);
}

function lstatSafe(p: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(p);
  } catch {
    return undefined;
  }
}
