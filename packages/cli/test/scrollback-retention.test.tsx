import { Writable } from "node:stream";
import { Box, Static, Text, render } from "ink";
import { useEffect, useState } from "react";
import { expect, it } from "vitest";
import { FrameAcks } from "../src/tui/frame-acks.js";
import { initialState } from "../src/tui/state.js";
import { acknowledgePrinted } from "../src/tui/view-retention.js";

it("prints each settled item once across retention resets and terminal resizing", async () => {
  const seen = new Uint16Array(1100);
  let erased = false;
  const stdout = Object.assign(
    new Writable({
      write(chunk, _encoding, done) {
        const text = String(chunk);
        for (const match of text.matchAll(/DONE_(\d+)/g)) {
          const index = Number(match[1]);
          seen[index] = (seen[index] ?? 0) + 1;
        }
        erased ||= text.includes("\x1b[3J");
        done();
      },
    }),
    { isTTY: true, rows: 24, columns: 80 },
  );
  const frames = new FrameAcks();
  let append: ((id: number) => void) | undefined;
  let maxRetained = 0;
  function View() {
    const [state, setState] = useState(() =>
      initialState({
        agentMode: "build",
        permission: "bypass",
        effort: "auto",
        requestedModel: "auto",
      }),
    );
    append = (id) =>
      setState((previous) => ({
        ...previous,
        transcript: [
          ...previous.transcript,
          { kind: "notice", id: String(id), level: "info", text: `DONE_${id}` },
        ],
      }));
    maxRetained = Math.max(maxRetained, state.transcript.length);
    const throughId = state.transcript.at(-1)?.id;
    useEffect(() => {
      if (state.transcript.length < 500 || !throughId) return;
      return frames.afterRender(() =>
        setState((previous) => acknowledgePrinted(previous, throughId)),
      );
    }, [throughId, state.transcript.length]);
    return (
      <Box flexDirection="column">
        <Static key={state.scrollbackEpoch ?? 0} items={state.transcript}>
          {(item) => <Text key={item.id}>{item.kind === "notice" ? item.text : ""}</Text>}
        </Static>
        <Text>active composer</Text>
      </Box>
    );
  }
  const previousCi = process.env.CI;
  process.env.CI = "false";
  const ui = render(<View />, {
    stdout,
    patchConsole: false,
    exitOnCtrlC: false,
    maxFps: 0,
    onRender: frames.rendered,
  });
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  try {
    await tick();
    for (let id = 0; id < seen.length; id++) {
      append?.(id);
      await tick();
      await ui.waitUntilRenderFlush();
      await tick();
      if (id % 100 === 0) {
        stdout.columns = id % 200 === 0 ? 70 : 90;
        stdout.emit("resize");
        await tick();
      }
    }
    await ui.waitUntilRenderFlush();
    expect([...seen]).toEqual(Array.from({ length: seen.length }, () => 1));
    expect(maxRetained).toBeLessThanOrEqual(501);
    expect(erased).toBe(false);
  } finally {
    ui.unmount();
    stdout.destroy();
    if (previousCi === undefined) Reflect.deleteProperty(process.env, "CI");
    else process.env.CI = previousCi;
  }
}, 20000);
