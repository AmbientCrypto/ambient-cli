import {
  type ChatRequest,
  KEYS_URL,
  fetchCatalog,
  resolveConfig,
  streamChatCompletion,
} from "@amb/ambient-api";
import { budgetFromCatalog, estimateTokens, preflight } from "@amb/context";
import { AmbError } from "@amb/protocol";
import { profileFor, resolveRequestedModel, streamTimeouts } from "@amb/reliability";
import { resolveWorkingApiKey } from "../agent/working-key.js";
import { cyan, dim } from "../render/color.js";
import { NOT_SIGNED_IN } from "../secrets.js";
import { mergeStdin, readPipedStdin } from "./stdin.js";

const SYSTEM =
  "You are amb, a concise expert coding assistant running on the Ambient network. Be direct.";

interface ChatArgs {
  model?: string;
  prompt: string;
  showReasoning: boolean;
  help: boolean;
  error?: string;
}

const USAGE = 'usage: ambient chat "<prompt>" [--model <id>] [--show-reasoning]';

function parseArgs(args: string[]): ChatArgs {
  let model: string | undefined;
  let showReasoning = false;
  let help = false;
  let error: string | undefined;
  const parts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--model" || a === "-m") {
      i += 1;
      model = args[i];
    } else if (a === "--show-reasoning") {
      showReasoning = true;
    } else if (a === "--help" || a === "-h") {
      help = true;
    } else if (a?.startsWith("--")) {
      // Reject a typo'd flag rather than sending it to the model as (billed) prompt text.
      error = error ?? `unknown flag "${a}" — ${USAGE}`;
    } else if (a) {
      parts.push(a);
    }
  }
  return { model, prompt: parts.join(" ").trim(), showReasoning, help, error };
}

function onboarding(): string {
  return `${NOT_SIGNED_IN}\n\nBrowsing the fleet works without a key:  ambient models`;
}

/** `ambient chat "<prompt>" [--model <id>] [--show-reasoning]` — talk to a live Ambient model. */
export async function runChat(args: string[]): Promise<void> {
  const { model: requested, prompt, showReasoning, help, error } = parseArgs(args);
  // `--help` must print usage WITHOUT signing in or sending a billed request (it used to fall through as the
  // prompt, spending a real completion just to say "--help").
  if (help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (error) {
    process.stderr.write(`ambient: ${error}\n`);
    process.exitCode = 1;
    return;
  }
  // Fold PIPED stdin into the prompt so `cat notes.md | amb chat "summarize"` works; a TTY is never read.
  const finalPrompt = mergeStdin(prompt, await readPipedStdin());
  if (!finalPrompt) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 1;
    return;
  }

  // A rejected saved key falls back to another key on this machine that works (and says so).
  const working = await resolveWorkingApiKey(resolveConfig().baseUrl);
  if (working?.note) process.stderr.write(`${working.note}\n`);
  const apiKey = working?.key;
  if (!apiKey) {
    process.stderr.write(`${onboarding()}\n`);
    process.exitCode = 1;
    return;
  }

  const config = { baseUrl: resolveConfig().baseUrl, apiKey };
  const catalog = await fetchCatalog(config);

  // ONE shared resolver (same as the agent + `route`) — no --model, or an explicit `auto`, picks the best live model.
  const res = resolveRequestedModel(requested, catalog);
  if (!res) {
    process.stderr.write("ambient: no models are available in the fleet right now.\n");
    process.exitCode = 1;
    return;
  }
  const target = res.target;
  // Surface a client-side substitution honestly — a cold model and an UNKNOWN id (typo) read differently so
  // a fat-fingered `--model` isn't silently served as if it were merely cold.
  if (res.rule === "ready-substitution" || res.rule === "unknown-substitution") {
    const why =
      res.rule === "unknown-substitution"
        ? "no such model — serving a live one"
        : "cold — serving a warm one";
    process.stderr.write(`${cyan(`↪ ${res.requested} → ${target}`)}  ${dim(`(${why})`)}\n`);
  }

  // Budget via the SHARED @amb/context preflight (no bespoke token math) — floor + window clamp in one place.
  const model = catalog.find((x) => x.id === target);
  const promptEstimate = estimateTokens(SYSTEM) + estimateTokens(finalPrompt);
  const pf = model
    ? preflight(budgetFromCatalog(model), {
        promptEstimate,
        requestedOutput: profileFor(target, model).budgets.desiredOutput,
        reasoning: true,
      })
    : undefined;
  // Overflow ⇒ the prompt leaves no room for output — fail with a clear message rather than sending
  // an invalid maxTokens:0 request that the wire schema (and the provider) would reject opaquely.
  if (pf?.overflow) {
    process.stderr.write(`ambient: the prompt is too long for ${target}'s context window.\n`);
    process.exitCode = 1;
    return;
  }
  const maxTokens = pf?.sentOutput ?? profileFor(target, model).budgets.desiredOutput;

  const req: ChatRequest = {
    model: target,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: finalPrompt },
    ],
    maxTokens,
  };

  try {
    const out = await streamChatCompletion(config, req, {
      timeouts: streamTimeouts({ promptTokens: promptEstimate }),
      onContent: (t) => process.stdout.write(t),
      onReasoning: showReasoning ? (t) => process.stderr.write(dim(t)) : undefined,
    });
    const served = out.reportedModel ?? target;
    const u = out.usage;
    const usageStr = u ? ` · in=${u.promptTokens ?? "?"} out=${u.completionTokens ?? "?"} tok` : "";
    process.stdout.write(`\n\n${dim(`[served: ${served}${usageStr}]`)}\n`);
  } catch (err) {
    if (err instanceof AmbError) {
      process.stderr.write(`\namb: ${chatErrorMessage(err)}\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

function chatErrorMessage(err: AmbError): string {
  switch (err.kind) {
    case "auth":
      return `Ambient rejected the API key. Check it at ${KEYS_URL}.`;
    case "cold":
      return "That model just went cold (no workers). Try again, or pick another with --model.";
    case "rate_limit":
      return "Rate limited by Ambient. Give it a moment and retry.";
    case "overflow":
      return "The prompt is too long for this model's context window.";
    default:
      return err.message;
  }
}
