import { Readable, Writable } from "node:stream";
import { render } from "ink";
import { createElement } from "react";
import { App } from "./packages/cli/src/tui/App.tsx";
import { FrameAcks } from "./packages/cli/src/tui/frame-acks.ts";
const tick = () => new Promise((resolve) => setImmediate(resolve));
const samples = [];
let frames = 0;
let bytes = 0;
let finished;
const completion = new Promise((resolve) => {
  finished = resolve;
});
const stdout = new Writable({
  write(chunk, encoding, done) {
    bytes += chunk.length;
    done();
  },
});
Object.assign(stdout, { isTTY: true, rows: 24, columns: 80 });
const stdin = new Readable({ read() {} });
Object.assign(stdin, { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
const client = {
  fetchCatalog: async () => [
    {
      id: "fixture/m",
      name: "m",
      contextLength: 128000,
      maxOutputLength: 8192,
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportedFeatures: ["tools"],
      supportedSamplingParameters: [],
      isReady: true,
    },
  ],
  chat: async (params) => {
    for (let i = 0; i < 50000; i++) {
      if (params.signal.aborted) throw Error("unexpected cancellation");
      params.onContent?.(`${String(i) + "x".repeat(4096)}\n\n`);
      await tick();
      await instance.waitUntilRenderFlush();
      await tick();
      if ((i + 1) % 10000 === 0) {
        global.gc();
        const heap = process.memoryUsage().heapUsed;
        samples.push(heap);
        process.stderr.write(
          `${JSON.stringify({ events: i + 1, frames, heapMiB: Math.round(heap / 1048576) })}\n`,
        );
      }
    }
    finished();
    return { content: "stress complete", toolCalls: [] };
  },
};
const acks = new FrameAcks();
const instance = render(
  createElement(App, {
    client,
    makeWriter: () => ({ append() {}, path: "/dev/null" }),
    initialTask: "stream stress",
    afterRender: acks.afterRender,
    agentMode: "build",
    permission: "bypass",
    effort: "auto",
    requestedModel: "fixture/m",
    maxTurns: 2,
    cwd: process.cwd(),
    workspaceRoot: process.cwd(),
  }),
  {
    stdout,
    stdin,
    patchConsole: false,
    exitOnCtrlC: false,
    maxFps: 0,
    onRender() {
      frames++;
      acks.rendered();
    },
  },
);
await completion;
await tick();
await tick();
instance.unmount();
stdin.destroy();
if (frames < 50000 || samples.at(-1) - samples[1] > 16 * 1048576)
  throw Error("TUI frame count or heap plateau failed");
process.stdout.write(
  `${JSON.stringify({
    events: 50000,
    frames,
    bytesWritten: bytes,
    heapMiB: samples.map((v) => Math.round(v / 1048576)),
  })}\n`,
);
