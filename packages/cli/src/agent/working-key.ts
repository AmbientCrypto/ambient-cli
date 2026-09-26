import { verifyApiKey } from "@amb/ambient-api";
import { KEY_SOURCE_LABEL, apiKeyCandidates, maskKey, saveApiKey } from "../secrets.js";
import { checkStartupKey } from "../tui/startup-key.js";

/**
 * The key a non-interactive run should use. With a single key on the machine it's used as-is (no extra
 * request). With several (e.g. this CLI's own plus one another Ambient app saved), the first is checked (free
 * — no model runs) and, if Ambient rejects it, the first one that works is used instead, with a note saying so.
 */
export async function resolveWorkingApiKey(
  baseUrl: string,
): Promise<{ key: string; note?: string } | undefined> {
  const all = [...apiKeyCandidates()];
  const first = all[0];
  if (!first) return undefined;
  if (all.length === 1) return { key: first.key };
  const r = await checkStartupKey(first, all, (key) => verifyApiKey({ baseUrl, apiKey: key }));
  if (r.alternative) {
    const alt = r.alternative;
    // ambient's own saved key went stale: replace it with the working one, so this never comes up again.
    if (first.source === "keychain" || first.source === "file") {
      try {
        saveApiKey(alt.key);
        return {
          key: alt.key,
          note: `Your saved Ambient key had stopped working. Replaced it with the working key ${maskKey(alt.key)} (${KEY_SOURCE_LABEL[alt.source]}).`,
        };
      } catch {
        // A locked keychain: use the working key for this run anyway.
      }
    }
    return {
      key: alt.key,
      note: `The key from ${KEY_SOURCE_LABEL[first.source]} was rejected — using ${maskKey(alt.key)} from ${KEY_SOURCE_LABEL[alt.source]}. ${
        first.source === "env"
          ? "Update or unset AMBIENT_API_KEY to stop seeing this."
          : "Run `ambient login` to fix it."
      }`,
    };
  }
  return { key: first.key };
}
