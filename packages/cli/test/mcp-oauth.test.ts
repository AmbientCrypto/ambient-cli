import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectMcp } from "../src/agent/mcp-connect.js";
import { browserCommand } from "../src/commands/login.js";
import { makeMcpAuth, realFetch } from "../src/mcp-auth/auth-port.js";
import { accessToken, discoverAuthServer, signIn } from "../src/mcp-auth/oauth.js";
import { makeTokenStore } from "../src/mcp-auth/token-store.js";

let dir: string;
let server: Server;
let base: string;
const state = {
  challenge: "",
  issued: 0,
  refreshed: 0,
  registeredRedirect: "",
  tokenRequests: [] as Record<string, string>[],
  validToken: "AT-1",
};

function json(
  res: import("node:http").ServerResponse,
  status: number,
  body: unknown,
  headers = {},
) {
  res
    .writeHead(status, { "content-type": "application/json", ...headers })
    .end(JSON.stringify(body));
}

async function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  let b = "";
  for await (const c of req) b += c;
  return b;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "amb-oauth-"));
  Object.assign(state, {
    challenge: "",
    issued: 0,
    refreshed: 0,
    tokenRequests: [],
    validToken: "AT-1",
  });
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", base);
    const body = await readBody(req);
    if (url.pathname === "/mcp") {
      if (req.headers.authorization !== `Bearer ${state.validToken}`) {
        json(
          res,
          401,
          { error: "unauthorized" },
          {
            "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
          },
        );
        return;
      }
      const msg = JSON.parse(body) as { id?: number; method: string };
      if (msg.id === undefined) return void res.writeHead(202).end();
      const result =
        msg.method === "tools/list"
          ? { tools: [{ name: "search", inputSchema: { type: "object" } }] }
          : { protocolVersion: "2025-06-18", capabilities: {} };
      json(res, 200, { jsonrpc: "2.0", id: msg.id, result });
      return;
    }
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      json(res, 200, {
        resource: `${base}/mcp`,
        authorization_servers: [`${base}/auth`],
        scopes_supported: ["read"],
      });
      return;
    }
    if (url.pathname === "/.well-known/oauth-authorization-server/auth") {
      json(res, 200, {
        issuer: `${base}/auth`,
        authorization_endpoint: `${base}/auth/authorize`,
        token_endpoint: `${base}/auth/token`,
        registration_endpoint: `${base}/auth/register`,
        code_challenge_methods_supported: ["S256"],
      });
      return;
    }
    if (url.pathname === "/auth/register") {
      const reg = JSON.parse(body) as { redirect_uris: string[] };
      state.registeredRedirect = reg.redirect_uris[0] ?? "";
      json(res, 201, { client_id: "client-123" });
      return;
    }
    if (url.pathname === "/auth/authorize") {
      state.challenge = url.searchParams.get("code_challenge") ?? "";
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("resource")).toBe(`${base}/mcp`);
      expect(url.searchParams.get("scope")).toBe("read");
      const back = new URL(url.searchParams.get("redirect_uri") ?? "");
      back.searchParams.set("code", "the-code");
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      res.writeHead(302, { location: back.toString() }).end();
      return;
    }
    if (url.pathname === "/auth/token") {
      const form = Object.fromEntries(new URLSearchParams(body));
      state.tokenRequests.push(form);
      if (form.grant_type === "authorization_code") {
        const expected = createHash("sha256")
          .update(form.code_verifier ?? "")
          .digest("base64url");
        if (form.code !== "the-code" || expected !== state.challenge)
          return json(res, 400, { error: "invalid_grant" });
        state.issued++;
        return json(res, 200, {
          access_token: "AT-1",
          refresh_token: "RT-1",
          expires_in: 3600,
          token_type: "Bearer",
        });
      }
      if (form.grant_type === "refresh_token" && form.refresh_token === "RT-1") {
        state.refreshed++;
        state.validToken = "AT-2";
        return json(res, 200, { access_token: "AT-2", expires_in: 3600 });
      }
      return json(res, 400, { error: "invalid_grant" });
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterEach(async () => {
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

/** The "browser": follow the authorization redirect to ambient's loopback callback. */
const fakeBrowser = (url: string) => {
  void (async () => {
    const res = await fetch(url, { redirect: "manual" });
    const next = res.headers.get("location");
    if (next) await fetch(next);
  })();
  return true;
};

const linuxStore = () => makeTokenStore({ platform: "linux", configDir: dir });

describe("signing in to an MCP server", () => {
  it("discovers, registers, runs PKCE through the browser, and stores the tokens encrypted", async () => {
    const store = linuxStore();
    const record = await signIn(`${base}/mcp`, {
      fetch: realFetch,
      store,
      openBrowser: fakeBrowser,
    });
    expect(record.tokens?.accessToken).toBe("AT-1");
    expect(state.registeredRedirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(store.get(`${base}/mcp`)?.tokens?.refreshToken).toBe("RT-1");
    const onDisk = readFileSync(join(dir, "mcp-sign-in.json"), "utf8");
    expect(onDisk).not.toContain("AT-1");
    expect(onDisk).not.toContain("RT-1");
    if (process.platform !== "win32") {
      expect(statSync(join(dir, "mcp-sign-in.json")).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, "mcp-sign-in.key")).mode & 0o777).toBe(0o600);
    }
  });

  it("refreshes an expired token, keeping the refresh token the server didn't rotate", async () => {
    const store = linuxStore();
    await signIn(`${base}/mcp`, { fetch: realFetch, store, openBrowser: fakeBrowser });
    const later = () => Date.now() + 2 * 3600_000;
    expect(await accessToken(`${base}/mcp`, { fetch: realFetch, store, now: later })).toBe("AT-2");
    expect(store.get(`${base}/mcp`)?.tokens?.refreshToken).toBe("RT-1");
    expect(state.refreshed).toBe(1);
  });

  it("connects with the stored token, and refreshes once when the server says it expired", async () => {
    const store = linuxStore();
    const spec = {
      name: "remote",
      transport: "http" as const,
      url: `${base}/mcp`,
      source: "user" as const,
    };
    const before = await connectMcp("/ws", {
      load: () => [spec],
      auth: makeMcpAuth(store, realFetch),
    });
    expect(before.servers[0]?.state).toBe("needs-sign-in");
    expect(before.notices.join("\n")).toContain("ambient mcp login remote");
    before.close();

    await signIn(`${base}/mcp`, { fetch: realFetch, store, openBrowser: fakeBrowser });
    state.validToken = "AT-2"; // the server revoked AT-1 early
    const after = await connectMcp("/ws", {
      load: () => [spec],
      auth: makeMcpAuth(store, realFetch),
    });
    expect(after.servers[0]).toMatchObject({ state: "connected", tools: 1 });
    expect(after.tools.map((t) => t.manifest.name)).toEqual(["mcp__remote__search"]);
    expect(state.refreshed).toBe(1);
    after.close();
  });

  it("refuses a sign-in endpoint that isn't https", async () => {
    const fetchImpl = async (url: string) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () =>
        JSON.stringify(
          url.includes("protected-resource")
            ? { authorization_servers: ["https://as.example"] }
            : {
                authorization_endpoint: "http://as.example/authorize",
                token_endpoint: "https://as.example/token",
              },
        ),
    });
    await expect(discoverAuthServer("https://mcp.example/mcp", null, fetchImpl)).rejects.toThrow(
      /isn't https/,
    );
  });
});

describe("the token store on macOS", () => {
  it("keeps only the encryption key in the keychain, written through stdin", () => {
    const keychain = new Map<string, string>();
    const argvSeen: string[][] = [];
    const run = (cmd: string, args: string[], input?: string) => {
      argvSeen.push([cmd, ...args]);
      if (args[0] === "find-generic-password") {
        const v = keychain.get(args[4] ?? "");
        if (!v) throw new Error("not found");
        return `${v}\n`;
      }
      const m = /-a "([^"]+)" -w "([0-9a-f]+)"/.exec(input ?? "");
      if (m?.[1] && m[2]) keychain.set(m[1], m[2]);
      return "";
    };
    const store = makeTokenStore({ platform: "darwin", run, configDir: dir });
    store.set("https://x/mcp", { tokens: { accessToken: "SECRET-TOKEN" } });
    expect(store.get("https://x/mcp")?.tokens?.accessToken).toBe("SECRET-TOKEN");
    expect(keychain.size).toBe(1);
    expect(JSON.stringify(argvSeen)).not.toMatch(/[0-9a-f]{64}/); // the key never rides on argv
    expect(readFileSync(join(dir, "mcp-sign-in.json"), "utf8")).not.toContain("SECRET-TOKEN");
    store.delete("https://x/mcp");
    expect(store.get("https://x/mcp")).toBeUndefined();
  });
});

describe("opening the browser", () => {
  it("never goes through a shell, and only opens web links", () => {
    const url = "https://as.example/authorize?a=1&b=2&state=x";
    const win = browserCommand(url, "win32");
    expect(win?.[0]).toMatch(/[\\/]System32[\\/]rundll32\.exe$/i);
    expect(win?.[1]).toEqual(["url.dll,FileProtocolHandler", url]);
    expect(browserCommand(url, "darwin")).toEqual(["open", [url]]);
    expect(browserCommand("file:///etc/passwd", "linux")).toBeUndefined();
    expect(browserCommand("javascript:alert(1)", "darwin")).toBeUndefined();
  });
});
