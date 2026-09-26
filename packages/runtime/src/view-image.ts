import type { CatalogModel, ImageAttachment, ToolDefinition } from "@amb/protocol";
import { resolveReadable } from "@amb/tools-core";
import { z } from "zod";
import { toDataUri } from "./attachments.js";
import type { ChatClient } from "./ports.js";
import { relayImageToText } from "./vision-relay.js";

const Input = z.object({
  path: z
    .string()
    .describe("The image file (png, jpg, gif, webp), relative to the workspace or absolute"),
});
const Output = z.object({
  image: z.number(),
  path: z.string(),
  /** What a vision model saw, when the model you're talking to can't see images itself. */
  description: z.string().optional(),
  note: z.string(),
});

/**
 * `view_image` — look at an image file: a screenshot the agent just took, a design mock, a chart a script
 * produced. A model that can see images gets the image itself with its next message; one that can't gets a
 * vision model's description now (and can ask follow-ups with `ask_vision`). Either way the image joins the
 * session's numbered images.
 */
export function makeViewImageTool(deps: {
  client: ChatClient;
  catalog: () => CatalogModel[];
  /** Load (and size) an image file for the conversation. */
  load: (absPath: string) => Promise<ImageAttachment>;
  /** Whether the model being served right now can see images. */
  canSee: () => boolean;
  /** Add the image to the session's numbered images; returns its number. */
  addToSession: (img: ImageAttachment) => number;
  /** Attach the image to the conversation for the next model call (vision models). */
  attach: (img: ImageAttachment, label: string) => void;
  targetWindow: () => number;
}): ToolDefinition<z.infer<typeof Input>, z.infer<typeof Output>> {
  return {
    manifest: {
      name: "view_image",
      version: "1",
      description:
        "Look at an image file (png, jpg, gif, webp) — a screenshot, a mockup, a chart. If you can see images it's attached to your next message; if not, you get a description from a vision model.",
      effects: ["read"],
      idempotency: "pure",
      parallelSafe: true,
      resumability: "replay",
      timeoutPolicy: { idleMs: 180_000, maximumMs: 300_000 },
    },
    inputSchema: Input,
    outputSchema: Output,
    async execute(input, ctx) {
      const abs = resolveReadable(ctx.workspaceRoot, input.path, ctx.readRoots?.list());
      if (ctx.readDenied?.(abs))
        throw new Error(`${input.path}: reading it is denied by your rules`);
      const img = await deps.load(abs);
      const n = deps.addToSession(img);
      const label = `Image #${n} (${input.path})`;
      if (deps.canSee()) {
        deps.attach(img, label);
        return { image: n, path: input.path, note: `${label} is attached to your next message.` };
      }
      const res = await relayImageToText({
        client: deps.client,
        catalog: deps.catalog(),
        imageDataUris: [toDataUri(img)],
        userText: `Describe ${input.path}`,
        signal: ctx.signal,
        targetWindow: deps.targetWindow(),
      });
      if (res.outcome !== "described" || !res.description) {
        const why =
          res.outcome === "no-model"
            ? "no vision-capable model is available on Ambient right now"
            : res.outcome === "cold"
              ? "every vision-capable model is cold right now"
              : "the vision model couldn't describe it";
        throw new Error(`couldn't look at ${input.path}: ${why}`);
      }
      return {
        image: n,
        path: input.path,
        description: res.description,
        note: `${label}, as described by ${res.visionModel ?? "a vision model"}. Ask ask_vision about image #${n} for details.`,
      };
    },
  };
}
