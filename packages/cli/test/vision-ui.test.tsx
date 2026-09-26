import type { NewEvent } from "@amb/protocol";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { Composer } from "../src/tui/components/Composer.js";
import { initialState, reduce } from "../src/tui/state.js";

const base = { schemaVersion: 1 as const, sessionId: "ses_a", turnId: "trn_a" };
const init = () =>
  initialState({ agentMode: "build", permission: "ask", effort: "auto", requestedModel: "m" });

describe("vision.relay reducer notice", () => {
  it("NATIVE (model saw the image) adds no transcript line — it just works", () => {
    const s = reduce(init(), {
      ...base,
      kind: "vision.relay",
      targetModel: "vendor/vl",
      imageCount: 1,
      outcome: "native",
    } as NewEvent);
    expect(s.transcript).toHaveLength(0);
  });

  it("DESCRIBED surfaces which vision model described it", () => {
    const s = reduce(init(), {
      ...base,
      kind: "vision.relay",
      targetModel: "deepseek/deepseek-v4-flash",
      imageCount: 1,
      outcome: "described",
      visionModel: "google/gemma-vl",
    } as NewEvent);
    const item = s.transcript[0] as { kind: string; text: string };
    expect(item.kind).toBe("receipt");
    expect(item.text).toContain("can't see images");
    expect(item.text).toContain("gemma-vl");
  });

  it("NO-MODEL degrades with an honest note", () => {
    const s = reduce(init(), {
      ...base,
      kind: "vision.relay",
      targetModel: "kimi/code",
      imageCount: 1,
      outcome: "no-model",
    } as NewEvent);
    expect((s.transcript[0] as { text: string }).text).toContain("no vision model is live");
  });
});

describe("Composer attachment chip", () => {
  it("shows a single-image chip with its size + remove hint", () => {
    const { lastFrame, unmount } = render(
      <Composer value="" running={false} width={80} attachments={[{ bytes: 20_480 }]} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("◫"); // geometric image mark, no emoji
    expect(frame).toContain("image attached");
    expect(frame).toContain("20 KB");
    expect(frame).toContain("⌫");
    unmount();
  });

  it("shows a count chip for multiple images", () => {
    const { lastFrame, unmount } = render(
      <Composer
        value="hi"
        running={false}
        width={80}
        attachments={[{ bytes: 1000 }, { bytes: 2000 }]}
      />,
    );
    expect(lastFrame() ?? "").toContain("2 images attached");
    unmount();
  });

  it("no chip when there are no attachments", () => {
    const { lastFrame, unmount } = render(<Composer value="" running={false} width={80} />);
    expect(lastFrame() ?? "").not.toContain("◫");
    unmount();
  });
});
