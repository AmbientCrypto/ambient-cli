import type { CatalogModel, ImageAttachment, ToolDefinition } from "@amb/protocol";
import { z } from "zod";
import { toDataUri } from "./attachments.js";
import type { ChatClient } from "./ports.js";
import { relayImageToText } from "./vision-relay.js";

const Input = z.object({
  image: z
    .number()
    .int()
    .min(1)
    .describe("Which image: 1 is the first image attached in this session"),
  question: z
    .string()
    .min(1)
    .max(2_000)
    .describe("What to find out about the image, as specifically as possible"),
});
const Output = z.object({
  answer: z.string(),
  visionModel: z.string().optional(),
});

/**
 * `ask_vision` — for a model that can't see images: ask a vision model on Ambient a specific question about an
 * image attached earlier ("what's the exact error text in the red box?"), instead of relying only on the
 * one-time description. Read-only; the answer comes back as text. Honest when no vision model can answer.
 */
export function makeAskVisionTool(deps: {
  client: ChatClient;
  catalog: () => CatalogModel[];
  images: () => readonly ImageAttachment[];
  targetWindow: () => number;
}): ToolDefinition<z.infer<typeof Input>, z.infer<typeof Output>> {
  return {
    manifest: {
      name: "ask_vision",
      version: "1",
      description:
        "You can't see images directly. Ask a vision model a specific question about an image the user attached in this session (numbered from 1) and get a text answer — e.g. exact text, a value in a chart, which element is highlighted.",
      effects: ["read"],
      idempotency: "pure",
      parallelSafe: true,
      resumability: "replay",
      timeoutPolicy: { idleMs: 180_000, maximumMs: 300_000 },
    },
    inputSchema: Input,
    outputSchema: Output,
    async execute(input, ctx) {
      const images = deps.images();
      const img = images[input.image - 1];
      if (!img) {
        throw new Error(
          `there is no image #${input.image} — this session has ${images.length} image${images.length === 1 ? "" : "s"}`,
        );
      }
      const res = await relayImageToText({
        client: deps.client,
        catalog: deps.catalog(),
        imageDataUris: [toDataUri(img)],
        userText: input.question,
        signal: ctx.signal,
        targetWindow: deps.targetWindow(),
        cache: new Map(), // a question-specific answer, never reused as the general description
        instruction: `Answer this question about the attached image for another AI that cannot see it. Be precise and literal; transcribe any relevant text exactly; say plainly if the image doesn't show it.\n\nQuestion: ${input.question}`,
      });
      if (res.outcome !== "described" || !res.description) {
        const why =
          res.outcome === "no-model"
            ? "no vision-capable model is available on Ambient right now"
            : res.outcome === "cold"
              ? "every vision-capable model is cold right now"
              : "the vision model couldn't answer";
        throw new Error(`couldn't look at image #${input.image}: ${why}`);
      }
      return {
        answer: res.description,
        ...(res.visionModel ? { visionModel: res.visionModel } : {}),
      };
    },
  };
}
