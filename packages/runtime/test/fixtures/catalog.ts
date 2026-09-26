import {
  type CatalogModel,
  CatalogResponseSchema,
  type RawCatalogModel,
  normalizeCatalog,
} from "@amb/protocol";
import type {
  ChatClient,
  ChatParams,
  RunOptions,
  TurnCompletion,
  WorkspaceContextPort,
} from "../../src/ports.js";

/**
 * Fixture catalog harness. Models are written in the API's raw snake_case shape and run through the REAL
 * parser, so every test exercises the same normalization the live `GET /v1/models` response goes through.
 * The three sizes cover the windows the fleet actually serves (32K vision, ~200K text, 1M text).
 */
export function raw(over: Partial<RawCatalogModel> & { id: string }): RawCatalogModel {
  return {
    name: over.id,
    input_modalities: ["text"],
    output_modalities: ["text"],
    context_length: 131_072,
    max_output_length: 8_192,
    supported_features: ["tools", "reasoning"],
    supported_sampling_parameters: ["max_tokens", "temperature"],
    is_ready: true,
    ...over,
  };
}

export const VISION_32K = raw({
  id: "fixture/vision-32k",
  input_modalities: ["text", "image"],
  context_length: 32_768,
  max_output_length: 8_192,
});
export const TEXT_200K = raw({
  id: "fixture/text-200k",
  context_length: 202_752,
  max_output_length: 202_752,
});
export const TEXT_1M = raw({
  id: "fixture/text-1m",
  context_length: 1_048_576,
  max_output_length: 65_536,
});

/** Variants: strip a capability or flip readiness without restating the whole record. */
export const noTools = (m: RawCatalogModel): RawCatalogModel => ({
  ...m,
  supported_features: (m.supported_features ?? []).filter((f) => f !== "tools"),
});
export const noReasoning = (m: RawCatalogModel): RawCatalogModel => ({
  ...m,
  supported_features: (m.supported_features ?? []).filter((f) => f !== "reasoning"),
});
export const cold = (m: RawCatalogModel): RawCatalogModel => ({ ...m, is_ready: false });

/** Build a normalized catalog from raw rows via the production parser. */
export function catalogOf(...rows: RawCatalogModel[]): CatalogModel[] {
  return normalizeCatalog(CatalogResponseSchema.parse({ object: "list", data: rows }));
}

/**
 * A scripted client whose catalog can CHANGE between turns (`setCatalog`) — for catalog-churn tests: a model
 * disappears, a 1M model appears, a model goes cold, all mid-session.
 */
export class FixtureClient implements ChatClient {
  public calls: ChatParams[] = [];
  private catalog: CatalogModel[];
  constructor(
    catalog: CatalogModel[],
    private readonly script: Array<TurnCompletion | ((p: ChatParams) => TurnCompletion)>,
  ) {
    this.catalog = catalog;
  }
  setCatalog(next: CatalogModel[]): void {
    this.catalog = next;
  }
  async fetchCatalog(): Promise<CatalogModel[]> {
    return this.catalog;
  }
  async chat(params: ChatParams): Promise<TurnCompletion> {
    // Snapshot the message list: the agent keeps appending to its array after the call returns.
    this.calls.push({ ...params, messages: [...params.messages] });
    const next = this.script.shift();
    if (!next) throw new Error("fixture script exhausted");
    return typeof next === "function" ? next(params) : next;
  }
}

/** An in-memory workspace port (no fs, fixed clock) so fixture tests stay hermetic. */
export function memWorkspace(): WorkspaceContextPort & { memory: string | undefined } {
  const ws = {
    memory: undefined as string | undefined,
    instructions: () => "",
    readMemory: () => ws.memory,
    writeMemory: (_root: string, s: string) => {
      ws.memory = s;
    },
    date: () => "2026-09-25",
    platform: () => "test",
    skills: () => [],
  };
  return ws;
}

/** Minimal RunOptions for fixture tests; override any field. */
export function runOpts(over: Partial<RunOptions> = {}): RunOptions {
  return {
    sessionId: "ses_fixture",
    mode: "bypass",
    requestedModel: "auto",
    maxTurns: 4,
    cwd: "/nonexistent-fixture-ws",
    workspaceRoot: "/nonexistent-fixture-ws",
    signal: new AbortController().signal,
    emit: () => {},
    approve: async () => "deny",
    workspace: memWorkspace(),
    ...over,
  };
}
