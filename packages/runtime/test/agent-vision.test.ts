import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadInstructions, readMemory, writeMemory } from "@amb/context";
import type { CatalogModel, ImageAttachment, NewEvent } from "@amb/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../src/agent.js";
import type {
  ChatClient,
  ChatParams,
  RunOptions,
  TurnCompletion,
  WorkspaceContextPort,
} from "../src/ports.js";
import { clearRelayCache } from "../src/vision-relay.js";

const testWorkspace = (): WorkspaceContextPort => ({
  instructions: (cwd) => loadInstructions(cwd).text,
  readMemory: (root) => readMemory(root),
  writeMemory: (root, s) => writeMemory(root, s),
  date: () => "2026-09-03",
  platform: () => "test",
  skills: () => [],
});

function model(id: string, over: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id,
    name: id,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportedFeatures: ["tools"],
    supportedSamplingParameters: [],
    contextLength: 262_144,
    maxOutputLength: 262_144,
    isReady: true,
    ...over,
  };
}

class MockClient implements ChatClient {
  public calls: ChatParams[] = [];
  constructor(
    private readonly catalog: CatalogModel[],
    private readonly script: TurnCompletion[],
  ) {}
  async fetchCatalog(): Promise<CatalogModel[]> {
    return this.catalog;
  }
  async chat(params: ChatParams): Promise<TurnCompletion> {
    this.calls.push(params);
    const next = this.script.shift();
    if (!next) throw new Error("mock script exhausted");
    return next;
  }
}

const img: ImageAttachment = {
  id: "att_1",
  mediaType: "image/png",
  dataBase64: "AAAABBBB",
  bytes: 6,
  sha256: "hash1",
  source: "clipboard",
  width: 800,
  height: 600,
};

let ws: string;
const collected: NewEvent[] = [];
const baseOpts = (over: Partial<RunOptions> = {}): RunOptions => ({
  sessionId: "ses_vis-0000",
  mode: "bypass",
  requestedModel: "vendor/m",
  maxTurns: 6,
  cwd: ws,
  workspaceRoot: ws,
  signal: new AbortController().signal,
  emit: (e) => collected.push(e),
  approve: async () => "deny",
  workspace: testWorkspace(),
  ...over,
});

beforeEach(async () => {
  clearRelayCache();
  ws = await mkdtemp(join(tmpdir(), "amb-vis-"));
  collected.length = 0;
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

const relayEvent = () =>
  collected.find((e) => e.kind === "vision.relay") as
    | { outcome: string; visionModel?: string; imageCount: number }
    | undefined;

describe("agent vision wiring", () => {
  it("VISION served model → the image rides as content-parts to the wire (native)", async () => {
    const client = new MockClient(
      [model("vendor/m", { inputModalities: ["text", "image"] })],
      [{ content: "That's a login screen.", toolCalls: [] }],
    );
    const res = await new Agent(client).run("what is this?", baseOpts({ attachments: [img] }));
    expect(res.stopReason).toBe("complete");
    const firstUser = client.calls[0]?.messages.find((m) => m.role === "user");
    expect(Array.isArray(firstUser?.content)).toBe(true); // content-parts, not a string
    const parts = firstUser?.content as { type: string }[];
    expect(parts.some((p) => p.type === "image_url")).toBe(true); // the image reaches the model
    expect(relayEvent()?.outcome).toBe("native");
  });

  it("BLIND served model → relays the image to a vision model, injects the description as TEXT", async () => {
    const client = new MockClient(
      [
        model("vendor/blind"), // served: no image modality
        model("google/vl", { inputModalities: ["text", "image"] }), // a ready vision model for the relay
      ],
      [
        { content: "A macOS terminal showing an ENOENT error on README.md.", toolCalls: [] }, // relay describe
        { content: "The file is missing — create it.", toolCalls: [] }, // the actual run turn
      ],
    );
    const res = await new Agent(client).run(
      "why the error?",
      baseOpts({ requestedModel: "vendor/blind", attachments: [img] }),
    );
    expect(res.stopReason).toBe("complete");
    // call[0] = the relay (to the vision model, WITH image parts)
    const relayUser = client.calls[0]?.messages.find((m) => m.role === "user");
    expect(client.calls[0]?.model).toBe("google/vl");
    expect(Array.isArray(relayUser?.content)).toBe(true);
    // call[1] = the actual run turn (to the blind model, content is a STRING with the injected description)
    const runUser = client.calls[1]?.messages.find((m) => m.role === "user");
    expect(typeof runUser?.content).toBe("string");
    expect(runUser?.content).toContain("ENOENT"); // the description was injected as text
    expect(relayEvent()?.outcome).toBe("described");
    expect(relayEvent()?.visionModel).toBe("google/vl");
  });

  it("BLIND served model + NO vision model in the fleet → honest degrade note, run proceeds", async () => {
    const client = new MockClient(
      [model("vendor/blind")], // no vision model at all
      [{ content: "I can't see it, but here's my best guess.", toolCalls: [] }],
    );
    const res = await new Agent(client).run(
      "look at this",
      baseOpts({ requestedModel: "vendor/blind", attachments: [img] }),
    );
    expect(res.stopReason).toBe("complete");
    const runUser = client.calls[0]?.messages.find((m) => m.role === "user");
    expect(typeof runUser?.content).toBe("string");
    expect(runUser?.content).toContain("can't see images");
    expect(relayEvent()?.outcome).toBe("no-model");
  });

  it("FAILOVER stays on a vision model — never ships image parts to a blind substitute", async () => {
    const { AmbError } = await import("@amb/protocol");
    // Served vision model errors; the fleet also has a BLIND model and another VISION model. The failover must
    // pick the vision substitute, and the blind model must NEVER receive image parts.
    const fleet = [
      model("a/vl", { inputModalities: ["text", "image"] }),
      model("b/blind"), // ready but blind
      model("c/vl", { inputModalities: ["text", "image"] }),
    ];
    const client = {
      calls: [] as ChatParams[],
      async fetchCatalog(): Promise<CatalogModel[]> {
        return fleet;
      },
      async chat(p: ChatParams): Promise<TurnCompletion> {
        this.calls.push(p);
        if (p.model === "a/vl")
          throw new AmbError({ kind: "cold", message: "no workers", retryable: true });
        return { content: "described from the substitute", toolCalls: [] };
      },
    };
    const res = await new Agent(client as unknown as ChatClient).run(
      "see this",
      baseOpts({ requestedModel: "a/vl", attachments: [img] }),
    );
    expect(res.stopReason).toBe("complete");
    // the blind model was never sent image parts
    const blindCalls = client.calls.filter((c) => c.model === "b/blind");
    for (const c of blindCalls) {
      const u = c.messages.find((m) => m.role === "user");
      expect(Array.isArray(u?.content)).toBe(false);
    }
    // the successful serve came from a vision model
    const served = client.calls.at(-1)?.model;
    expect(["a/vl", "c/vl"]).toContain(served);
    expect(served).not.toBe("b/blind");
  });

  it("records attachment REFERENCES on turn.started (never the base64 bytes)", async () => {
    const client = new MockClient(
      [model("vendor/m", { inputModalities: ["text", "image"] })],
      [{ content: "ok", toolCalls: [] }],
    );
    await new Agent(client).run("hi", baseOpts({ attachments: [img] }));
    const started = collected.find((e) => e.kind === "turn.started") as {
      attachments?: { sha256: string; dataBase64?: string }[];
    };
    expect(started.attachments?.[0]?.sha256).toBe("hash1");
    expect(started.attachments?.[0]).not.toHaveProperty("dataBase64"); // bytes never logged
  });
});
