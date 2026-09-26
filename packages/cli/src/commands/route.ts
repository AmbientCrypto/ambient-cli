import { join } from "node:path";
import { fetchCatalog, resolveConfig } from "@amb/ambient-api";
import { CapabilityStore, laneFor, resolveRecord } from "@amb/capabilities";
import { budgetFromCatalog } from "@amb/context";
import { type CatalogModel, availability } from "@amb/protocol";
import { resolveRequestedModel } from "@amb/reliability";
import { ambHome } from "@amb/sessions";
import { bold, dim } from "../render/color.js";
import { resolveApiKey } from "../secrets.js";

/** `ambient route explain [model-id]` — show why a model + lane would be chosen for a task. */
export async function runRoute(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub !== "explain") {
    process.stderr.write("usage: ambient route explain [model-id]\n");
    process.exitCode = 1;
    return;
  }
  const requestedArg = rest.find((a) => !a.startsWith("-"));

  const config = { baseUrl: resolveConfig().baseUrl, apiKey: resolveApiKey() };
  const catalog = await fetchCatalog(config);
  // ONE shared resolver (same as the agent + `chat`): no id / explicit `auto` explains the best live pick.
  const res = resolveRequestedModel(requestedArg, catalog);
  if (!res) {
    process.stderr.write("ambient: no models are available in the fleet right now.\n");
    process.exitCode = 1;
    return;
  }
  const { requested, target, rule } = res;
  const store = new CapabilityStore(join(ambHome(), "capabilities.json"));
  const now = Date.now();

  const requestedModel = catalog.find((m) => m.id === requested);
  process.stdout.write(`${bold("route explain")} ${dim(`— requested: ${requested}`)}\n\n`);

  if (rule === "auto-best") {
    process.stdout.write(
      `  ${dim("no model requested → auto-picked the best live model:")} ${bold(target)}\n`,
    );
  } else if (!requestedModel) {
    process.stdout.write(
      "  ⚠ not in the live catalog. It would be resolved by ready-substitution.\n",
    );
  } else {
    printModel(requestedModel, store, now, "requested");
  }

  // Ready/cold substitution decision.
  const targetModel = catalog.find((m) => m.id === target);
  if (rule === "ready-substitution") {
    process.stdout.write(
      `\n  ↪ ${dim("would substitute →")} ${bold(target)} ${dim("(requested is cold/absent; picking a warm model)")}\n`,
    );
    if (targetModel) printModel(targetModel, store, now, "served");
  }

  const finalModel = targetModel ?? requestedModel;
  if (finalModel) {
    const rec = resolveRecord(finalModel, store.get(finalModel.id), now);
    const lane = laneFor(finalModel, rec);
    process.stdout.write(
      `\n  ${bold("decision:")} run on ${bold(finalModel.id)} in the ${bold(lane)} lane ${dim(`(evidence: ${rec.provenance}, tool-calling=${rec.toolCalling})`)}\n`,
    );
    if (lane === "assisted")
      process.stdout.write(
        dim("  → tools are described as text; the model replies with a fenced action envelope.\n"),
      );
  }
}

function printModel(m: CatalogModel, store: CapabilityStore, now: number, label: string): void {
  const rec = resolveRecord(m, store.get(m.id), now);
  const lane = laneFor(m, rec);
  const b = budgetFromCatalog(m);
  process.stdout.write(
    `  ${dim(`[${label}]`)} ${m.id}\n` +
      `      availability: ${availability(m)}\n` +
      `      lane: ${lane}  ${dim(`(${rec.provenance}; tool-calling=${rec.toolCalling})`)}\n` +
      `      context window: ${b.contextWindow}  ·  output cap: ${b.outputCap}\n`,
  );
}
