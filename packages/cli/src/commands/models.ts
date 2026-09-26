import { fetchCatalog, resolveConfig } from "@amb/ambient-api";
import { renderFleet } from "../render/fleet.js";

/** `amb models [--json]` — fetch and display the live Ambient fleet (no API key required). */
export async function runModels(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const config = resolveConfig();
  const models = await fetchCatalog(config);
  if (json) {
    // Capabilities only — prices are never shown by the CLI, in any format.
    const shown = models.map(({ pricing: _pricing, ...rest }) => rest);
    process.stdout.write(`${JSON.stringify(shown, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${renderFleet(models).join("\n")}\n`);
}
