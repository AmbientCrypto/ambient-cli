import { join } from "node:path";
import {
  type AmbientConfig,
  fetchCatalog,
  resolveConfig,
  streamChatCompletion,
} from "@amb/ambient-api";
import { CapabilityStore, laneFor, probedRecord, resolveRecord } from "@amb/capabilities";
import { AmbError, type CatalogModel } from "@amb/protocol";
import { streamTimeouts } from "@amb/reliability";
import { ambHome } from "@amb/sessions";
import { resolveWorkingApiKey } from "../agent/working-key.js";
import { bold, dim } from "../render/color.js";
import { NOT_SIGNED_IN } from "../secrets.js";

/** A minimal tool the probe asks the model to call, to test native tool-calling. */
const PROBE_TOOL = {
  type: "function",
  function: {
    name: "report_sum",
    description: "Report the sum of two integers.",
    parameters: {
      type: "object",
      properties: { sum: { type: "integer", description: "a + b" } },
      required: ["sum"],
    },
  },
};

function capabilitiesPath(): string {
  return join(ambHome(), "capabilities.json");
}

/** Live-test one model's native tool-calling. Returns true iff it emitted a well-formed call. */
async function probeModel(config: AmbientConfig, modelId: string): Promise<boolean> {
  const out = await streamChatCompletion(
    config,
    {
      model: modelId,
      messages: [
        {
          role: "system",
          content: "You must answer by calling the provided tool. Do not reply in text.",
        },
        { role: "user", content: "What is 21 + 21? Call report_sum with the result." },
      ],
      tools: [PROBE_TOOL],
      maxTokens: 512,
    },
    { timeouts: streamTimeouts({ promptTokens: 200 }) },
  );
  const call = out.toolCalls.find((c) => c.name === "report_sum");
  if (!call) return false;
  try {
    JSON.parse(call.arguments);
    return true;
  } catch {
    return false;
  }
}

/** `ambient probe <model-id>` or `ambient probe --all` — live-test native tool-calling; record + display. */
export async function runProbe(args: string[]): Promise<void> {
  const all = args.includes("--all");
  const modelId = args.find((a) => !a.startsWith("-"));
  if (!all && !modelId) {
    process.stderr.write("usage: ambient probe <model-id>   |   ambient probe --all\n");
    process.exitCode = 1;
    return;
  }
  // A rejected saved key falls back to another key on this machine that works (and says so).
  const working = await resolveWorkingApiKey(resolveConfig().baseUrl);
  if (working?.note) process.stderr.write(`${working.note}\n`);
  const apiKey = working?.key;
  if (!apiKey) {
    process.stderr.write(`${NOT_SIGNED_IN}\n`);
    process.exitCode = 1;
    return;
  }
  const config = { baseUrl: resolveConfig().baseUrl, apiKey };
  const catalog = await fetchCatalog(config);
  const store = new CapabilityStore(capabilitiesPath());

  if (all) {
    await probeAll(config, catalog, store);
    return;
  }

  const model = catalog.find((m) => m.id === modelId);
  if (!model) {
    process.stderr.write(`ambient: no such model in the live catalog: ${modelId}\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`${bold("probing")} ${modelId} ${dim("(native tool-calling)…")}\n`);
  let worked: boolean;
  try {
    worked = await probeModel(config, model.id);
  } catch (err) {
    if (err instanceof AmbError) {
      process.stderr.write(`ambient: probe failed — ${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  store.put(probedRecord(model.id, worked, Date.now()));
  // Show the EFFECTIVE stored record — the provenance store may keep stronger fresh evidence over this probe.
  const rec = resolveRecord(model, store.get(model.id), Date.now());
  const lane = laneFor(model, rec);
  process.stdout.write(
    `${worked ? "✓" : "✗"} ${model.id}: probe → native tool-calling ${worked ? "works" : "unreliable"}${dim(`; effective lane=${lane} (${rec.provenance})`)}\n`,
  );
  if (rec.provenance !== "probed")
    process.stdout.write(
      dim(`  → kept stronger ${rec.provenance} evidence; the probe was recorded but not adopted\n`),
    );
}

/**
 * Probe every model and print a conformance matrix (the live model-matrix). Readiness is only a hint (flagged
 * models serve), so every model is tried; one that really can't serve shows the error it returned.
 */
async function probeAll(
  config: AmbientConfig,
  catalog: CatalogModel[],
  store: CapabilityStore,
): Promise<void> {
  process.stdout.write(
    `${bold("AMBIENT MODEL MATRIX")} ${dim(`— ${catalog.length} model${catalog.length === 1 ? "" : "s"}`)}\n\n`,
  );

  for (const m of catalog) {
    process.stderr.write(dim(`  probing ${m.id}…\r`));
    let worked = false;
    let note = "";
    try {
      worked = await probeModel(config, m.id);
    } catch (err) {
      note = err instanceof AmbError ? `[${err.kind}]` : "[error]";
    }
    if (!note) store.put(probedRecord(m.id, worked, Date.now()));
    const lane = laneFor(m, resolveRecord(m, store.get(m.id), Date.now()));
    const glyph = note ? "•" : worked ? "✓" : "✗";
    process.stdout.write(
      `  ${glyph} ${m.id.padEnd(34)} lane=${lane.padEnd(11)} ${note || (worked ? "native tools ✓" : "assisted (text protocol)")}\n`,
    );
  }
  process.stdout.write(
    dim(
      "\nModels with working native tool calls run direct; the rest use the assisted lane. A model that can't serve right now shows its error.\n",
    ),
  );
}
