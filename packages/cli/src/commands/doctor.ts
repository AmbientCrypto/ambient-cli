import { KEYS_URL, fetchCatalog, resolveConfig, verifyApiKey } from "@amb/ambient-api";
import { createBuiltinRegistry } from "@amb/tools-core";
import { githubStatus, githubSummary } from "../agent/github.js";
import { resolveWorkingApiKey } from "../agent/working-key.js";
import { loadConfig } from "../config.js";
import { bold, dim } from "../render/color.js";
import { KEY_SOURCE_LABEL, maskKey, resolveApiKeyWithSource } from "../secrets.js";
import { checkForUpdate, updateHint } from "../update-check.js";
import { CURRENT_VERSION } from "../version.js";

/** `ambient doctor` — self-diagnostic: node version, config, key presence, live catalog reachability. */
export async function runDoctor(): Promise<void> {
  const ok = (s: string) => process.stdout.write(`  ✓ ${s}\n`);
  const warn = (s: string) => process.stdout.write(`  ! ${s}\n`);
  process.stdout.write(`${bold("ambient doctor")}\n\n`);

  // Version + a best-effort "newer available" check (cached, never blocks — offline just shows the version).
  // Honor the same opt-out as everywhere else: config `checkUpdates: false` (and env / CI, inside checkForUpdate).
  const upd = await checkForUpdate({ enabled: loadConfig().checkUpdates });
  if (upd?.updateAvailable) warn(updateHint(upd));
  else ok(`ambient ${CURRENT_VERSION}${upd ? " (up to date)" : ""}`);

  ok(`node ${process.version}`);

  const builtins = createBuiltinRegistry().list();
  ok(
    `${builtins.length} built-in tools + subagent (plus your MCP servers) — see /tools in the TUI`,
  );

  let baseUrl = "";
  try {
    baseUrl = resolveConfig().baseUrl;
    ok(`base URL ${baseUrl}`);
  } catch (err) {
    warn(`base URL invalid: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const found = resolveApiKeyWithSource();
  const key = found?.key;
  if (found) {
    const where = `${maskKey(found.key)} (from ${KEY_SOURCE_LABEL[found.source]})`;
    const check = await verifyApiKey({ baseUrl, apiKey: found.key });
    if (check === "valid") ok(`API key ${where} — accepted by Ambient`);
    else if (check === "unknown") warn(`API key ${where} — couldn't reach Ambient to check it`);
    else {
      warn(
        `API key ${where} — REJECTED by Ambient (revoked or mistyped); run 'ambient login' to replace it`,
      );
      const working = await resolveWorkingApiKey(baseUrl);
      if (working && working.key !== found.key)
        ok(`meanwhile ambient uses ${maskKey(working.key)}, which works`);
    }
  } else
    warn(
      `not signed in — 'ambient models' works without a key; run 'ambient login' (or create one at ${KEYS_URL}) to run tasks`,
    );

  try {
    const models = await fetchCatalog({ baseUrl, apiKey: key });
    // Readiness isn't reported: the catalog's flag is only a hint (flagged models serve), and a model that
    // really can't answer is failed over at request time.
    ok(`catalog reachable: ${models.length} model${models.length === 1 ? "" : "s"}`);
    const unsized = models.filter((m) => m.contextLength === undefined).map((m) => m.id);
    if (unsized.length > 0)
      warn(
        `${unsized.length} model(s) don't publish a context window (${unsized.slice(0, 3).join(", ")}${unsized.length > 3 ? ", …" : ""}) — ambient budgets them conservatively`,
      );
  } catch (err) {
    warn(`catalog unreachable: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  // GitHub sign-in (optional — used for commit/push/PR work; never blocks the CLI).
  const gh = githubStatus();
  if (gh.authed) ok(githubSummary(gh).replace(/^GitHub:\s*/, "GitHub — "));
  else warn(githubSummary(gh).replace(/^GitHub:\s*/, "GitHub — "));

  process.stdout.write(dim("\nAll systems go.\n"));
}
