import { describe, expect, it } from "vitest";
import {
  JsonRpcClient,
  JsonRpcError,
  LineFramer,
  McpClient,
  type Transport,
  resultToText,
} from "../src/index.js";

/** An in-memory transport pair wired to a scripted fake MCP server — no child process, fully deterministic. */
function fakeServer(handler: (method: string, params: unknown) => unknown): {
  transport: Transport;
  closeServer: (err?: Error) => void;
} {
  let onMsg: (m: unknown) => void = () => {};
  let onClose: (err?: Error) => void = () => {};
  const transport: Transport = {
    send: (line) => {
      const req = JSON.parse(line) as { id?: number; method: string; params: unknown };
      if (req.id === undefined) return; // a notification — no reply
      // Reply asynchronously (like a real pipe).
      queueMicrotask(() => {
        try {
          const result = handler(req.method, req.params);
          onMsg({ jsonrpc: "2.0", id: req.id, result });
        } catch (e) {
          onMsg({
            jsonrpc: "2.0",
            id: req.id,
            error: { message: (e as Error).message, code: -32000 },
          });
        }
      });
    },
    onMessage: (cb) => {
      onMsg = cb;
    },
    onClose: (cb) => {
      onClose = cb;
    },
    close: () => {},
  };
  return { transport, closeServer: (err) => onClose(err) };
}

describe("LineFramer", () => {
  it("reassembles JSON messages across chunk boundaries and drops junk lines", () => {
    const got: unknown[] = [];
    const f = new LineFramer((m) => got.push(m));
    f.push('{"a":1}\n{"b":');
    f.push('2}\nnot json\n{"c":3}\n');
    expect(got).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it("drops an over-long unterminated line and resyncs at the next newline (memory-DoS bound)", () => {
    const got: unknown[] = [];
    const f = new LineFramer((m) => got.push(m), 64); // tiny cap for the test
    // A server streams a huge blob with no newline — must be discarded, not buffered forever.
    f.push("x".repeat(500));
    f.push("y".repeat(500));
    // The eventual newline ends the dropped line; the NEXT complete message frames normally.
    f.push('\n{"ok":1}\n');
    expect(got).toEqual([{ ok: 1 }]);
  });

  it("drops an over-cap COMPLETED line whose newline arrives in the same chunk (no parse)", () => {
    const got: unknown[] = [];
    const f = new LineFramer((m) => got.push(m), 64);
    // The whole oversized line + its newline arrive together — it must NOT be parsed/delivered.
    f.push(`${JSON.stringify({ big: "z".repeat(500) })}\n{"ok":2}\n`);
    expect(got).toEqual([{ ok: 2 }]);
  });
});

describe("JsonRpcClient", () => {
  it("round-trips a request/response and surfaces server errors", async () => {
    const { transport } = fakeServer((method) => {
      if (method === "ping") return { ok: true };
      throw new Error("unknown method");
    });
    const rpc = new JsonRpcClient(transport);
    expect(await rpc.request("ping")).toEqual({ ok: true });
    await expect(rpc.request("nope")).rejects.toBeInstanceOf(JsonRpcError);
  });

  it("rejects all in-flight requests when the transport closes", async () => {
    const { transport, closeServer } = fakeServer(() => new Promise(() => {}));
    const rpc = new JsonRpcClient(transport, { requestTimeoutMs: 5000 });
    const p = rpc.request("hang");
    closeServer(new Error("server died"));
    await expect(p).rejects.toThrow(/server died|closed/);
  });

  it("times out a request that never gets a reply", async () => {
    const { transport } = fakeServer(() => {
      throw new Error("never"); // handler throws → but we test timeout via a non-replying server below
    });
    // A server that simply never replies:
    const silent: Transport = { ...transport, send: () => {} };
    const rpc = new JsonRpcClient(silent, { requestTimeoutMs: 20 });
    await expect(rpc.request("slow")).rejects.toThrow(/timed out/);
  });
});

describe("McpClient", () => {
  const server = () =>
    fakeServer((method, params) => {
      if (method === "initialize") return { protocolVersion: "2025-06-18", capabilities: {} };
      if (method === "tools/list")
        return {
          tools: [
            { name: "echo", description: "echoes text", inputSchema: { type: "object" } },
            { name: "add" },
          ],
        };
      if (method === "tools/call") {
        const p = params as { name: string; arguments: { text?: string } };
        if (p.name === "boom")
          return { content: [{ type: "text", text: "kaboom" }], isError: true };
        return { content: [{ type: "text", text: `echo:${p.arguments.text ?? ""}` }] };
      }
      throw new Error(`unexpected ${method}`);
    });

  it("handshakes, lists tools (validated), and calls a tool", async () => {
    const { transport } = server();
    const c = new McpClient(new JsonRpcClient(transport));
    await c.initialize();
    const tools = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(["echo", "add"]);
    const r = await c.callTool("echo", { text: "hi" });
    expect(resultToText(r)).toBe("echo:hi");
  });

  it("flattens an error result with the tool-error prefix", async () => {
    const { transport } = server();
    const c = new McpClient(new JsonRpcClient(transport));
    await c.initialize();
    expect(resultToText(await c.callTool("boom", {}))).toBe("tool error: kaboom");
  });

  it("rejects a malformed tools/list shape", async () => {
    const { transport } = fakeServer((m) => (m === "tools/list" ? { tools: "nope" } : {}));
    const c = new McpClient(new JsonRpcClient(transport));
    await expect(c.listTools()).rejects.toThrow(/malformed tools\/list/);
  });

  it("bounds an oversized tool result so an untrusted server can't flood the context", async () => {
    const { transport } = fakeServer((m) =>
      m === "tools/call" ? { content: [{ type: "text", text: "z".repeat(1_000_000) }] } : {},
    );
    const c = new McpClient(new JsonRpcClient(transport));
    const text = resultToText(await c.callTool("big", {}));
    expect(text.length).toBeLessThanOrEqual(262_145); // MAX_RESULT_CHARS + the ellipsis
    expect(text.endsWith("…")).toBe(true);
  });

  it("trims outer whitespace BEFORE the cap so leading padding can't displace real content", () => {
    // Regression guard: leading spaces then real text must survive (not collapse to just an ellipsis).
    const text = resultToText({ content: [{ type: "text", text: `${" ".repeat(300_000)}fatal` }] });
    expect(text).toBe("fatal");
  });

  it("uses a separate (longer) timeout for a tool call than for the handshake", async () => {
    // Server answers initialize immediately but never replies to tools/call.
    let onMsg: (m: unknown) => void = () => {};
    const transport: Transport = {
      send: (line) => {
        const req = JSON.parse(line) as { id?: number; method: string };
        if (req.id === undefined) return;
        if (req.method === "initialize")
          queueMicrotask(() => onMsg({ jsonrpc: "2.0", id: req.id, result: { capabilities: {} } }));
        // tools/call: intentionally silent → must reject on the CALL timeout, not the init one.
      },
      onMessage: (cb) => {
        onMsg = cb;
      },
      onClose: () => {},
      close: () => {},
    };
    // Short init timeout (would fire fast) but the call timeout governs tools/call.
    const c = new McpClient(new JsonRpcClient(transport, { requestTimeoutMs: 10_000 }), {
      callTimeoutMs: 20,
    });
    await c.initialize();
    await expect(c.callTool("slow", {})).rejects.toThrow(/timed out after 20ms/);
  });
});
