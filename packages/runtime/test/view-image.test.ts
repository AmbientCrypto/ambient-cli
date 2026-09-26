import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageAttachment } from "@amb/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../src/agent.js";
import type { ChatParams } from "../src/ports.js";
import { clearRelayCache } from "../src/vision-relay.js";
import { FixtureClient, TEXT_200K, VISION_32K, catalogOf, runOpts } from "./fixtures/catalog.js";

let ws: string;
beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), "amb-viewimg-")));
  writeFileSync(join(ws, "shot.png"), "fake png bytes");
  clearRelayCache();
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const loaded: string[] = [];
const loadImage = async (abs: string): Promise<ImageAttachment> => {
  loaded.push(abs);
  return {
    id: "img_1",
    mediaType: "image/png",
    dataBase64: "iVBORw0KGgo=",
    bytes: 10,
    sha256: "abc",
    source: "file",
  } as ImageAttachment;
};
const view = {
  content: "",
  toolCalls: [
    { id: "tc_v", name: "view_image", args: { path: "shot.png" }, rawArgs: '{"path":"shot.png"}' },
  ],
};
const hasImagePart = (p: ChatParams) =>
  p.messages.some(
    (m) => Array.isArray(m.content) && JSON.stringify(m.content).includes("image_url"),
  );

describe("view_image", () => {
  it("a model that can see gets the image itself with its next call", async () => {
    let second: ChatParams | undefined;
    const client = new FixtureClient(catalogOf(VISION_32K), [
      view,
      (p: ChatParams) => {
        second = p;
        return { content: "I see it", toolCalls: [] };
      },
    ]);
    const r = await new Agent(client).run(
      "look at shot.png",
      runOpts({ requestedModel: VISION_32K.id, cwd: ws, workspaceRoot: ws, loadImage }),
    );
    expect(second && hasImagePart(second)).toBe(true);
    expect(JSON.stringify(second?.messages)).toContain("[Image #1 (shot.png)]");
    expect(r.sessionImages).toHaveLength(1);
  });

  it("a model that can't see gets a vision model's description as the result", async () => {
    const vision = { ...VISION_32K, id: "vendor/vision" };
    let relayed = false;
    const client = new FixtureClient(catalogOf(TEXT_200K, vision), [
      view,
      (p: ChatParams) => {
        // the relay call to the vision model carries the image
        relayed = hasImagePart(p);
        return { content: "A red error banner reading 'ENOSPC'.", toolCalls: [] };
      },
      (p: ChatParams) => {
        expect(JSON.stringify(p.messages)).toContain("ENOSPC");
        expect(hasImagePart(p)).toBe(false);
        return { content: "done", toolCalls: [] };
      },
    ]);
    await new Agent(client).run(
      "look",
      runOpts({ requestedModel: TEXT_200K.id, cwd: ws, workspaceRoot: ws, loadImage }),
    );
    expect(relayed).toBe(true);
  });

  it("isn't offered without an image loader", async () => {
    const client = new FixtureClient(catalogOf(VISION_32K), [{ content: "ok", toolCalls: [] }]);
    await new Agent(client).run(
      "hi",
      runOpts({ requestedModel: VISION_32K.id, cwd: ws, workspaceRoot: ws }),
    );
    const names = (client.calls[0]?.tools ?? []).map(
      (t) => (t as { function: { name: string } }).function.name,
    );
    expect(names).toContain("read");
    expect(names).not.toContain("view_image");
  });
});
