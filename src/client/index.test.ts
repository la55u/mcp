import { describe, expect, test, vi } from "vitest";
import { ConvexError, v } from "convex/values";
import { McpServer, callToolResult, createPrompt, prompt, tool } from "./index.js";
import { components } from "./setup.test.js";

function server(tools: ConstructorParameters<typeof McpServer>[1]["tools"]) {
  return new McpServer(components.mcp, {
    name: "test",
    version: "1",
    consentUrl: "https://app.example/connect",
    siteUrl: "https://site.example",
    scopes: { read: "Read", write: "Write" },
    tools,
  });
}

// A ctx whose token lookup returns a valid connection with `scopes`.
function ctx(scopes = ["read", "write"]) {
  return {
    runQuery: vi.fn(async () => ({
      userId: "user1",
      grantId: "g1",
      kind: "apiKey",
      scopes,
      resource: "https://site.example/mcp",
      stale: false,
    })),
    runMutation: vi.fn(),
    runAction: vi.fn(),
  } as any;
}

async function call(s: McpServer, c: any, body: unknown, version = "2025-06-18") {
  const res = await s.handleMcp(
    c,
    new Request("https://site.example/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer key",
        "MCP-Protocol-Version": version,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

// `id: null` builds a notification (no id).
const rpc = (method: string, params?: unknown, id: number | null = 1) => ({
  jsonrpc: "2.0",
  ...(id === null ? {} : { id }),
  method,
  params,
});

describe("McpServer", () => {
  test("enforces `returns` so extra fields never leak", async () => {
    const s = server({
      whoami: tool({
        description: "Who am I",
        returns: v.object({ name: v.string() }),
        handler: async () => ({ name: "Ada", passwordHash: "secret" }) as any,
      }),
    });
    const r = await call(s, ctx(), rpc("tools/call", { name: "whoami", arguments: {} }));
    expect(r.body.result.isError).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain("secret");
  });

  test("passes the verified user to handlers, never arguments", async () => {
    const handler = vi.fn(async (_ctx: unknown, args: { n: bigint }, user: { userId: string }) => ({
      n: args.n * 2n,
      user: user.userId,
    }));
    const s = server({
      double: tool({
        description: "Double",
        args: { n: v.int64() },
        returns: v.object({ n: v.int64(), user: v.string() }),
        handler,
      }),
    });
    const r = await call(s, ctx(), rpc("tools/call", { name: "double", arguments: { n: "21" } }));
    expect(r.body.result.structuredContent).toEqual({ n: "42", user: "user1" });
  });

  test("ConvexError messages reach the model; other errors don't", async () => {
    const s = server({
      a: tool({ description: "a", handler: async () => { throw new ConvexError("Nope: try list_x"); } }),
      b: tool({ description: "b", handler: async () => { throw new Error("db password is hunter2"); } }),
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = await call(s, ctx(), rpc("tools/call", { name: "a", arguments: {} }));
    const b = await call(s, ctx(), rpc("tools/call", { name: "b", arguments: {} }));
    spy.mockRestore();
    expect(a.body.result.content[0].text).toBe("Nope: try list_x");
    expect(b.body.result.isError).toBe(true);
    expect(b.body.result.content[0].text).not.toContain("hunter2");
  });

  test("scopes filter tools/list and gate tools/call with 403", async () => {
    const s = server({
      r: tool({ description: "r", scope: "read", handler: async () => "ok" }),
      w: tool({ description: "w", scope: "write", handler: async () => "ok" }),
    });
    const list = await call(s, ctx(["read"]), rpc("tools/list"));
    expect(list.body.result.tools.map((t: any) => t.name)).toEqual(["r"]);
    const denied = await call(s, ctx(["read"]), rpc("tools/call", { name: "w", arguments: {} }));
    expect(denied.status).toBe(403);
    expect(denied.headers.get("WWW-Authenticate")).toContain('scope="write"');
  });

  test("protocol: notifications get 202, batches only for 2025-03-26", async () => {
    const s = server({});
    expect((await call(s, ctx(), rpc("notifications/initialized", undefined, null))).status).toBe(202);
    expect((await call(s, ctx(), [rpc("ping")])).status).toBe(400);
    const batch = await call(s, ctx(), [rpc("ping", {}, 1), rpc("ping", {}, 2)], "2025-03-26");
    expect(batch.body.map((m: any) => m.id)).toEqual([1, 2]);
    const unknown = await call(s, ctx(), rpc("resources/list"));
    expect(unknown.body.error.code).toBe(-32601);
  });

  test("tokens for another resource are rejected", async () => {
    const s = server({});
    const c = ctx();
    c.runQuery.mockResolvedValueOnce({
      userId: "u",
      grantId: "g",
      kind: "access",
      scopes: [],
      resource: "https://other.example/mcp",
      stale: false,
    });
    expect((await call(s, c, rpc("ping"))).status).toBe(401);
  });

  test("browser origins must be allowed", async () => {
    const s = server({});
    const res = await s.handleMcp(
      ctx(),
      new Request("https://site.example/mcp", {
        method: "POST",
        headers: { Origin: "https://evil.example", Authorization: "Bearer key" },
        body: JSON.stringify(rpc("ping")),
      }),
    );
    expect(res.status).toBe(403);
  });

  test("rejects tools with undeclared scopes", () => {
    expect(() =>
      server({ x: tool({ description: "x", scope: "admin", handler: async () => null }) }),
    ).toThrow(/scope "admin"/);
  });
});

describe("MCP 2026-07-28 (stateless)", () => {
  const META = "io.modelcontextprotocol/";
  const meta = {
    [`${META}protocolVersion`]: "2026-07-28",
    [`${META}clientCapabilities`]: {},
    [`${META}clientInfo`]: { name: "test", version: "1" },
  };
  async function modern(
    s: McpServer,
    method: string,
    params: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ) {
    const res = await s.handleMcp(
      ctx(),
      new Request("https://site.example/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer key",
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": method,
          ...(typeof params.name === "string" ? { "Mcp-Name": params.name } : {}),
          ...headers,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: meta } }),
      }),
    );
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
  const s = () =>
    server({
      echo: tool({
        description: "Echo",
        args: { text: v.string() },
        returns: v.object({ text: v.string() }),
        handler: async (_ctx, args) => ({ text: args.text }),
      }),
    });

  test("server/discover advertises versions, capabilities and identity", async () => {
    const r = await modern(s(), "server/discover");
    expect(r.status).toBe(200);
    expect(r.body.result).toMatchObject({
      resultType: "complete",
      supportedVersions: expect.arrayContaining(["2026-07-28", "2025-11-25"]),
      capabilities: { tools: {} },
      cacheScope: "public",
      _meta: { [`${META}serverInfo`]: { name: "test", version: "1" } },
    });
  });

  test("tools/list and tools/call carry resultType and cache hints", async () => {
    const list = await modern(s(), "tools/list");
    expect(list.body.result).toMatchObject({ resultType: "complete", cacheScope: "private" });
    expect(list.body.result.ttlMs).toBeGreaterThan(0);
    const call = await modern(s(), "tools/call", { name: "echo", arguments: { text: "hi" } });
    expect(call.body.result).toMatchObject({
      resultType: "complete",
      structuredContent: { text: "hi" },
    });
  });

  test("headers must match the body (-32020)", async () => {
    const wrongName = await modern(
      s(),
      "tools/call",
      { name: "echo", arguments: { text: "x" } },
      { "Mcp-Name": "other" },
    );
    expect(wrongName.status).toBe(400);
    expect(wrongName.body.error.code).toBe(-32020);
    const wrongMethod = await modern(s(), "tools/list", {}, { "Mcp-Method": "tools/call" });
    expect(wrongMethod.body.error.code).toBe(-32020);
    // Base64 sentinel values are decoded before comparing.
    const encoded = await modern(
      s(),
      "tools/call",
      { name: "echo", arguments: { text: "x" } },
      { "Mcp-Name": `=?base64?${btoa("echo")}?=` },
    );
    expect(encoded.status).toBe(200);
  });

  test("unsupported versions list what is supported (-32022)", async () => {
    const res = await s().handleMcp(
      ctx(),
      new Request("https://site.example/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer key", "MCP-Protocol-Version": "2099-01-01", "Mcp-Method": "tools/list" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: { _meta: { ...meta, [`${META}protocolVersion`]: "2099-01-01" } },
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe(-32022);
    expect(body.error.data).toMatchObject({ requested: "2099-01-01", supported: expect.arrayContaining(["2026-07-28"]) });
  });

  test("missing required _meta is -32602 / 400; unknown methods 404", async () => {
    const res = await s().handleMcp(
      ctx(),
      new Request("https://site.example/mcp", {
        method: "POST",
        headers: { Authorization: "Bearer key", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32602);
    const ping = await modern(s(), "ping");
    expect(ping.status).toBe(404);
    expect(ping.body.error.code).toBe(-32601);
  });

  test("tool _meta survives next to serverInfo", async () => {
    const srv = server({
      styled: tool({
        description: "Styled",
        meta: { "com.example/category": "charts" },
        handler: async () =>
          callToolResult({
            content: [{ type: "text", text: "ok" }],
            _meta: { "com.example/theme": "dark" },
          }),
      }),
    });
    const list = await modern(srv, "tools/list");
    expect(list.body.result.tools[0]._meta).toEqual({
      "com.example/category": "charts",
    });
    // Both the app's keys and the server's identity are present: merge, not replace.
    const res = await modern(srv, "tools/call", { name: "styled", arguments: {} });
    expect(res.body.result._meta).toEqual({
      "com.example/theme": "dark",
      [`${META}serverInfo`]: { name: "test", version: "1" },
    });
  });

  test("legacy clients still initialize", async () => {
    const r = await call(s(), ctx(), rpc("initialize", { protocolVersion: "2025-11-25" }), "2025-11-25");
    expect(r.body.result.protocolVersion).toBe("2025-11-25");
    // A legacy client asking for an unknown version gets the latest legacy one.
    const r2 = await call(s(), ctx(), rpc("initialize", { protocolVersion: "2026-07-28" }), "2025-06-18");
    expect(r2.body.result.protocolVersion).toBe("2025-11-25");
  });
});

describe("_meta", () => {
  const appMeta = {
    "com.example/category": "dashboards",
    "com.example/flags": { pinned: true },
  };

  const withMeta = () =>
    server({
      show: tool({
        description: "Show a dashboard",
        meta: appMeta,
        handler: async () =>
          callToolResult({
            content: [{ type: "text", text: "ok" }],
            _meta: appMeta,
          }),
      }),
      plain: tool({ description: "Plain", handler: async () => "ok" }),
    });

  test("tools/list advertises tool _meta, and omits it when unset", async () => {
    const r = await call(withMeta(), ctx(), rpc("tools/list"));
    const [show, plain] = r.body.result.tools;
    expect(show._meta).toEqual(appMeta);
    expect(plain).not.toHaveProperty("_meta");
  });

  test("a tool result _meta reaches the client", async () => {
    const r = await call(withMeta(), ctx(), rpc("tools/call", { name: "show", arguments: {} }));
    expect(r.body.result._meta).toEqual(appMeta);
    expect(r.body.result.content).toEqual([{ type: "text", text: "ok" }]);
  });
});

describe("callToolResult", () => {
  test("structuredContent is still checked against returns", async () => {
    const s = server({
      leak: tool({
        description: "leak",
        returns: v.object({ name: v.string() }),
        handler: async () =>
          callToolResult({
            content: [{ type: "text", text: "ok" }],
            structuredContent: { name: "x", secret: "s" },
          }) as any,
      }),
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await call(s, ctx(), rpc("tools/call", { name: "leak", arguments: {} }));
    spy.mockRestore();
    expect(r.body.result.isError).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain("secret");
  });
});

describe("lint", () => {
  test("flags missing scopes and annotations", () => {
    const bare = new McpServer(components.mcp, {
      name: "x",
      version: "1",
      consentUrl: "https://app.example/connect",
      siteUrl: "https://site.example",
      tools: { t: tool({ description: "t", handler: async () => null }) },
    });
    const findings = bare.lint();
    expect(findings.some((f) => f.includes("No `scopes`"))).toBe(true);
    expect(findings.some((f) => f.includes('"t" has no annotations'))).toBe(true);
  });

  test("vMcpUser validates the user passed to internal functions", async () => {
    const { vMcpUser } = await import("./index.js");
    const { checkValue } = await import("./schema.js");
    const validator = vMcpUser();
    expect(checkValue(validator, { userId: "u", scopes: [], connectionId: "c" }).ok).toBe(true);
    expect(checkValue(validator, { userId: "u" }).ok).toBe(false);
  });
});

describe("GET /mcp guide", () => {

  test("explains device sign-in; hides tools unless describeTools", async () => {
    const s = server({ secret_tool: tool({ description: "Internal thing", handler: async () => null }) });
    const text = s.guide();
    expect(text).toContain("client_id=mcp-agent");
    expect(text).toContain("https://site.example/mcp/oauth/device");
    expect(text).not.toContain("secret_tool");
    const open = new McpServer(components.mcp, {
      name: "t",
      version: "1",
      consentUrl: "https://app.example/connect",
      siteUrl: "https://site.example",
      describeTools: true,
      tools: { secret_tool: tool({ description: "Internal thing", handler: async () => null }) },
    });
    expect(open.guide()).toContain("secret_tool");
  });
});

describe("prompts", () => {
  const META = "io.modelcontextprotocol/";
  const meta = {
    [`${META}protocolVersion`]: "2026-07-28",
    [`${META}clientCapabilities`]: {},
  };

  async function modernPost(
    s: McpServer,
    method: string,
    params: Record<string, unknown> = {},
    scopes = ["read", "write"],
    headers: Record<string, string> = {},
  ) {
    const res = await s.handleMcp(
      ctx(scopes),
      new Request("https://site.example/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer key",
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": method,
          ...(typeof params.name === "string" ? { "Mcp-Name": params.name } : {}),
          ...headers,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: meta } }),
      }),
    );
    return { status: res.status, headers: res.headers, body: await res.json() };
  }

  const withPrompts = () => {
    const typedPrompt = createPrompt<string>();
    return new McpServer(components.mcp, {
      name: "test",
      version: "1",
      consentUrl: "https://example.com/connect",
      siteUrl: "https://site.example",
      scopes: { read: "Read", write: "Write" },
      tools: {},
      prompts: {
        review: prompt({
          title: "Review list",
          description: "Review a list for the user",
          args: {
            list: { description: "List name", required: true },
            tone: { description: "Optional tone" },
          },
          scope: "read",
          meta: { "com.example/category": "review" },
          handler: async (_ctx, args, user) => {
            const list: string = args.list;
            const tone: string | undefined = args.tone;
            return `Review ${list} for ${user.userId} (${tone ?? "concise"})`;
          },
        }),
        convo: typedPrompt({
          description: "Multi-turn prompt with embedded resource",
          scope: "write",
          handler: async () => [
            { role: "user", content: { type: "text", text: "Check this doc" } },
            {
              role: "assistant",
              content: {
                type: "resource",
                resource: { uri: "app://doc/1", mimeType: "text/plain", text: "Hello" },
              },
            },
          ],
        }),
        custom: prompt({
          description: "Default description",
          scope: "read",
          handler: async () => ({
            description: "Custom description",
            messages: [{ role: "user", content: { type: "text", text: "hi" } }],
            _meta: { "com.example/tag": "v1" },
          }),
        }),
        fail_convex: prompt({
          description: "Throws ConvexError",
          scope: "read",
          handler: async () => {
            throw new ConvexError("List not found");
          },
        }),
        fail_secret: prompt({
          description: "Throws internal error",
          scope: "read",
          handler: async () => {
            throw new Error("db secret hunter2");
          },
        }),
      },
    });
  };

  test("capability is advertised only when prompts exist", async () => {
    const without = server({});
    const legacyWithout = await call(without, ctx(), rpc("initialize", { protocolVersion: "2025-11-25" }), "2025-11-25");
    expect(legacyWithout.body.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect((await call(without, ctx(), rpc("prompts/list"))).body.error.code).toBe(-32601);
    const modernWithout = await modernPost(without, "prompts/list");
    expect(modernWithout.status).toBe(404);
    expect(modernWithout.body.error.code).toBe(-32601);

    const withThem = withPrompts();
    const legacyWith = await call(withThem, ctx(), rpc("initialize", { protocolVersion: "2025-11-25" }), "2025-11-25");
    expect(legacyWith.body.result.capabilities.prompts).toEqual({ listChanged: false });
    const discover = await modernPost(withThem, "server/discover");
    expect(discover.body.result.capabilities.prompts).toEqual({ listChanged: false });
  });

  test("prompts/list filters by scope and includes cache hints on 2026-07-28 only", async () => {
    const s = withPrompts();
    const legacy = await call(s, ctx(["read"]), rpc("prompts/list"), "2025-11-25");
    expect(legacy.body.result.prompts.map((p: any) => p.name)).toEqual([
      "review",
      "custom",
      "fail_convex",
      "fail_secret",
    ]);
    expect(legacy.body.result.prompts[0]).toEqual({
      name: "review",
      title: "Review list",
      description: "Review a list for the user",
      arguments: [
        { name: "list", description: "List name", required: true },
        { name: "tone", description: "Optional tone" },
      ],
      _meta: { "com.example/category": "review" },
    });
    expect("ttlMs" in legacy.body.result).toBe(false);

    const modernList = await modernPost(s, "prompts/list", {}, ["read", "write"]);
    expect(modernList.body.result).toMatchObject({
      resultType: "complete",
      cacheScope: "private",
    });
    expect(modernList.body.result.ttlMs).toBeGreaterThan(0);
    expect(modernList.body.result.prompts.map((p: any) => p.name)).toContain("convo");
  });

  test("prompts/get handles string, messages array, and full result with _meta", async () => {
    const s = withPrompts();
    const str = await modernPost(s, "prompts/get", {
      name: "review",
      arguments: { list: "Groceries", tone: "brief" },
    });
    expect(str.status).toBe(200);
    expect(str.body.result).toMatchObject({
      resultType: "complete",
      description: "Review a list for the user",
      messages: [
        { role: "user", content: { type: "text", text: "Review Groceries for user1 (brief)" } },
      ],
    });

    const arr = await call(s, ctx(), rpc("prompts/get", { name: "convo" }), "2025-11-25");
    expect(arr.body.result).toEqual({
      description: "Multi-turn prompt with embedded resource",
      messages: [
        { role: "user", content: { type: "text", text: "Check this doc" } },
        {
          role: "assistant",
          content: {
            type: "resource",
            resource: { uri: "app://doc/1", mimeType: "text/plain", text: "Hello" },
          },
        },
      ],
    });

    const full = await modernPost(s, "prompts/get", { name: "custom" });
    expect(full.body.result.description).toBe("Custom description");
    expect(full.body.result._meta).toEqual({
      "com.example/tag": "v1",
      [`${META}serverInfo`]: { name: "test", version: "1" },
    });
  });

  test("prompts/get validates name, scopes, arguments, Mcp-Name, and errors", async () => {
    const s = withPrompts();

    // Unknown prompt
    expect((await modernPost(s, "prompts/get", { name: "nope" })).body.error.code).toBe(-32602);
    expect((await call(s, ctx(), rpc("prompts/get", { name: "nope" }))).body.error.code).toBe(-32602);

    // Out-of-scope prompt
    const denied = await modernPost(s, "prompts/get", { name: "convo" }, ["read"]);
    expect(denied.status).toBe(403);
    expect(denied.headers.get("WWW-Authenticate")).toContain('scope="write"');

    // Missing required argument, non-string argument, unknown argument
    expect((await modernPost(s, "prompts/get", { name: "review" })).body.error.code).toBe(-32602);
    expect(
      (await modernPost(s, "prompts/get", { name: "review", arguments: { list: 123 } })).body.error.code,
    ).toBe(-32602);
    expect(
      (await modernPost(s, "prompts/get", { name: "review", arguments: { list: "ok", extra: "bad" } })).body
        .error.code,
    ).toBe(-32602);

    // Mcp-Name header mismatch on 2026-07-28
    const badHeader = await modernPost(s, "prompts/get", { name: "custom" }, ["read"], {
      "Mcp-Name": "other",
    });
    expect(badHeader.status).toBe(400);
    expect(badHeader.body.error.code).toBe(-32020);

    // ConvexError message passes through; unknown errors do not leak
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const convexErr = await modernPost(s, "prompts/get", { name: "fail_convex" });
    const secretErr = await modernPost(s, "prompts/get", { name: "fail_secret" });
    spy.mockRestore();
    expect(convexErr.body.error).toEqual({ code: -32603, message: "List not found" });
    expect(secretErr.body.error.code).toBe(-32603);
    expect(secretErr.body.error.message).not.toContain("hunter2");
  });

  test("rejects prompts with undeclared scopes", () => {
    expect(
      () =>
        new McpServer(components.mcp, {
          name: "t",
          version: "1",
          consentUrl: "https://example.com/connect",
          siteUrl: "https://site.example",
          scopes: { read: "Read" },
          tools: {},
          prompts: {
            x: prompt({ description: "x", scope: "admin", handler: async () => "hi" }),
          },
        }),
    ).toThrow(/scope "admin"/);
  });
});
