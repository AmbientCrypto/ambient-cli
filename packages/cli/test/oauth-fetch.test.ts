import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { realFetch } from "../src/mcp-auth/auth-port.js";

let server: Server | undefined;
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
});

describe("sign-in requests", () => {
  it("stop reading an answer that never ends", async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      const pump = () => {
        while (res.write(chunk)) {}
        res.once("drain", pump);
      };
      pump();
    });
    await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    const res = await realFetch(`http://127.0.0.1:${port}/token`, { method: "POST", body: "" });
    await expect(res.text()).rejects.toThrow(/too large/);
  });
});
