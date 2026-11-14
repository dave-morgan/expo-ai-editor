import { decodeClientMessage, encodeServerMessage, type ClientMessage } from "@dave-morgan/expo-ai-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BridgeClient,
  BridgePairError,
  MemoryTokenStore,
  probeBridge,
  type ConnectionState,
  type WebSocketLike,
} from "../src/bridge/client";

const health = { name: "expo-ai-bridge", version: "0.1.0", protocolVersion: 1 };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function pairingFetch(body: unknown, status = 200): typeof fetch {
  return vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith("/health") ? jsonResponse(health) : jsonResponse(body, status),
  );
}

class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: ClientMessage[] = [];
  onopen: WebSocketLike["onopen"] = null;
  onmessage: WebSocketLike["onmessage"] = null;
  onclose: WebSocketLike["onclose"] = null;
  onerror: WebSocketLike["onerror"] = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    const decoded = decodeClientMessage(data);
    if (!decoded.ok) throw new Error(decoded.error);
    this.sent.push(decoded.value);
  }
  close(code = 1000) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(message: Parameters<typeof encodeServerMessage>[0]) {
    this.onmessage?.({ data: encodeServerMessage(message) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }
}

const welcome = {
  type: "welcome" as const,
  protocolVersion: 1 as const,
  bridgeVersion: "0.1.0",
  sessionId: "s1",
  project: { id: "example-expo", name: "Example" },
  selectedThreadId: null,
  capabilities: {
    adapter: "t3-cli",
    listThreads: true,
    queue: true,
    steer: false,
    attachments: false,
    runStatus: true,
  },
  screenshotsAccepted: true,
};

const feedback = {
  requestId: "req_00000001",
  projectId: "example-expo",
  threadId: "thread-1",
  instruction: "Make it smaller",
  inputMethod: "typed" as const,
  createdAt: new Date().toISOString(),
};

function createClient(tokens = new MemoryTokenStore(), fetchImpl?: typeof fetch) {
  const states: ConnectionState[] = [];
  const client = new BridgeClient({
    bridgeUrl: "http://192.168.1.20:8790",
    projectId: "example-expo",
    clientId: "client-1",
    device: { platform: "ios" },
    tokenStore: tokens,
    createSocket: (url) => new FakeSocket(url),
    ...(fetchImpl ? { fetchImpl } : {}),
    minRetryMs: 100,
    maxRetryMs: 1000,
  });
  client.on("state", (state) => states.push(state));
  return { client, states, tokens };
}

describe("BridgeClient", () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("reports unpaired when no token is stored", async () => {
    const { client, states } = createClient();
    await client.start();
    expect(states.at(-1)).toEqual({ status: "unpaired" });
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it("pairs over HTTP, stores the token and authenticates the socket", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/health")) return jsonResponse(health);
      expect(JSON.parse(String(init?.body))).toMatchObject({
        code: "123456",
        projectId: "example-expo",
        clientId: "client-1",
      });
      return new Response(
        JSON.stringify({ token: "t".repeat(43), expiresAt: "x", projectId: "example-expo" }),
        { status: 200 },
      );
    });
    const { client, tokens, states } = createClient(
      new MemoryTokenStore(),
      fetchImpl as unknown as typeof fetch,
    );
    await client.pair("123456");
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "http://192.168.1.20:8790/health",
      "http://192.168.1.20:8790/pair",
    ]);
    expect(await tokens.get(client.tokenKey)).toBe("t".repeat(43));
    const socket = FakeSocket.instances[0]!;
    expect(socket.url).toBe("ws://192.168.1.20:8790/ws");
    socket.open();
    expect(socket.sent[0]).toMatchObject({
      type: "hello",
      token: "t".repeat(43),
      projectId: "example-expo",
      protocolVersion: 1,
    });
    socket.receive(welcome);
    expect(states.at(-1)).toMatchObject({ status: "connected", projectName: "Example" });
  });

  it("reuses the paired client id after an app reload (tokens are bound to it)", async () => {
    const fetchImpl = pairingFetch({
      token: "t".repeat(43),
      expiresAt: "x",
      projectId: "example-expo",
    });
    const tokens = new MemoryTokenStore();
    const first = createClient(tokens, fetchImpl as unknown as typeof fetch).client;
    await first.pair("123456");
    first.stop();
    const reloaded = new BridgeClient({
      bridgeUrl: "http://192.168.1.20:8790",
      projectId: "example-expo",
      clientId: "client-after-reload",
      device: { platform: "ios" },
      tokenStore: tokens,
      createSocket: (url) => new FakeSocket(url),
    });
    await reloaded.start();
    const socket = FakeSocket.instances.at(-1)!;
    socket.open();
    expect(socket.sent[0]).toMatchObject({ type: "hello", clientId: "client-1" });
  });

  it("surfaces pairing errors from the bridge", async () => {
    const fetchImpl = pairingFetch({ error: "invalid_code", message: "Invalid pairing code" }, 401);
    const { client } = createClient(new MemoryTokenStore(), fetchImpl as unknown as typeof fetch);
    await expect(client.pair("000000")).rejects.toThrow("Invalid pairing code");
  });

  it("queues submissions while disconnected and flushes them after welcome", async () => {
    const tokens = new MemoryTokenStore();
    const { client } = createClient(tokens);
    await tokens.set(client.tokenKey, "x".repeat(32));
    await client.start();
    client.submit(feedback);
    const socket = FakeSocket.instances[0]!;
    socket.open();
    expect(socket.sent.map((m) => m.type)).toEqual(["hello"]);
    socket.receive(welcome);
    expect(socket.sent.map((m) => m.type)).toEqual(["hello", "feedback.submit"]);
  });

  it("reconnects with backoff after a dropped connection and resends queued work", async () => {
    const tokens = new MemoryTokenStore();
    const { client, states } = createClient(tokens);
    await tokens.set(client.tokenKey, "x".repeat(32));
    await client.start();
    const first = FakeSocket.instances[0]!;
    first.open();
    first.receive(welcome);
    first.drop();
    expect(states.at(-1)).toMatchObject({ status: "disconnected" });
    client.submit(feedback);
    await vi.advanceTimersByTimeAsync(1000);
    const second = FakeSocket.instances[1]!;
    expect(second).toBeDefined();
    second.open();
    second.receive(welcome);
    expect(second.sent.map((m) => m.type)).toEqual(["hello", "feedback.submit"]);
  });

  it("drops the token and stops reconnecting on a fatal unauthorized error", async () => {
    const tokens = new MemoryTokenStore();
    const { client, states } = createClient(tokens);
    await tokens.set(client.tokenKey, "x".repeat(32));
    await client.start();
    const socket = FakeSocket.instances[0]!;
    socket.open();
    socket.receive({ type: "error", code: "unauthorized", message: "Token expired", fatal: true });
    await vi.advanceTimersByTimeAsync(5000);
    expect(states.at(-1)).toEqual({ status: "unpaired", reason: "Token expired" });
    expect(await tokens.get(client.tokenKey)).toBeNull();
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("emits thread lists and raw messages", async () => {
    const tokens = new MemoryTokenStore();
    const { client } = createClient(tokens);
    await tokens.set(client.tokenKey, "x".repeat(32));
    const threads = vi.fn();
    const messages = vi.fn();
    client.on("threads", threads);
    client.on("message", messages);
    await client.start();
    const socket = FakeSocket.instances[0]!;
    socket.open();
    socket.receive(welcome);
    socket.receive({
      type: "threads",
      threads: [{ threadId: "t1", title: "Main", status: "idle" }],
      selectedThreadId: "t1",
    });
    socket.receive({
      type: "request.status",
      requestId: "req_00000001",
      phase: "agent_working",
      at: "now",
    });
    expect(threads).toHaveBeenCalledWith({
      threads: [{ threadId: "t1", title: "Main", status: "idle" }],
      selectedThreadId: "t1",
    });
    expect(messages.mock.calls.map(([m]) => m.type)).toEqual([
      "welcome",
      "threads",
      "request.status",
    ]);
  });

  it("rejects invalid outgoing messages at the call site", () => {
    const { client } = createClient();
    expect(() => client.submit({ ...feedback, threadId: "bad id; rm" })).toThrow();
  });

  it.each([
    ["unauthorized", "Press p", 401],
    ["rate_limited", "Wait a minute", 429],
    ["unknown_project", "projects[].id", 404],
    ["invalid_message", "request format", 400],
  ])("explains the %s pairing rejection", async (code, hint, status) => {
    const { client, tokens } = createClient(
      new MemoryTokenStore(),
      pairingFetch({ error: code }, status),
    );
    await expect(client.pair("123456")).rejects.toMatchObject({
      name: "BridgePairError",
      kind: "rejected",
      code,
      url: "http://192.168.1.20:8790",
      message: expect.stringContaining(hint),
    });
    expect(await tokens.get(client.tokenKey)).toBeNull();
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it.each([{}, { message: "Proxy denied request" }, null])(
    "rejects codeless pairing responses as not_bridge: %j",
    async (body) => {
      const { client } = createClient(new MemoryTokenStore(), pairingFetch(body, 403));
      await expect(client.pair("123456")).rejects.toMatchObject({
        kind: "not_bridge",
        message: expect.stringContaining("http_proxy"),
      });
    },
  );

  it("rejects HTML from the pairing endpoint", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith("/health")
        ? jsonResponse(health)
        : new Response("<html>Proxy</html>", { status: 403 }),
    );
    const { client } = createClient(new MemoryTokenStore(), fetchImpl);
    await expect(client.pair("123456")).rejects.toBeInstanceOf(BridgePairError);
    await expect(client.pair("123456")).rejects.toMatchObject({ kind: "not_bridge" });
  });

  it("stops pairing after an unsuccessful probe", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ ...health, protocolVersion: 2 }),
    );
    const { client } = createClient(new MemoryTokenStore(), fetchImpl);
    await expect(client.pair("123456")).rejects.toMatchObject({ kind: "incompatible" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("explains a network failure after a successful probe", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith("/health")) return jsonResponse(health);
      throw new TypeError("Failed to fetch");
    });
    const { client } = createClient(new MemoryTokenStore(), fetchImpl);
    await expect(client.pair("123456")).rejects.toMatchObject({
      kind: "unreachable",
      message: expect.stringContaining("adb reverse tcp:8790 tcp:8790"),
    });
  });
});

describe("probeBridge", () => {
  afterEach(() => vi.useRealTimers());

  it("normalizes the URL and identifies a compatible bridge", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(health));
    await expect(probeBridge(" http://localhost:9123/// ", { fetchImpl })).resolves.toEqual({
      ok: true,
      url: "http://localhost:9123",
      version: "0.1.0",
      protocolVersion: 1,
    });
    expect(fetchImpl).toHaveBeenCalledWith("http://localhost:9123/health", {
      method: "GET",
      signal: expect.any(AbortSignal),
    });
  });

  it.each([
    ["HTML", () => new Response("<html>Proxy</html>")],
    ["HTTP failure", () => jsonResponse(health, 503)],
    ["another service", () => jsonResponse({ ...health, name: "metro" })],
    ["malformed health", () => jsonResponse({ name: "expo-ai-bridge" })],
  ])("classifies %s as not_bridge with proxy troubleshooting", async (_label, response) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response());
    await expect(probeBridge("http://localhost:9123", { fetchImpl })).resolves.toMatchObject({
      ok: false,
      kind: "not_bridge",
      detail: expect.stringContaining("adb shell settings get global http_proxy"),
    });
  });

  it("reports incompatible protocol versions", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ ...health, protocolVersion: 2 }),
    );
    await expect(probeBridge("http://localhost:9123", { fetchImpl })).resolves.toMatchObject({
      ok: false,
      kind: "incompatible",
      detail: expect.stringContaining("protocol 2"),
    });
  });

  it("includes the actual port in unreachable advice", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError("Network request failed");
    });
    await expect(probeBridge("http://localhost:9123", { fetchImpl })).resolves.toMatchObject({
      ok: false,
      kind: "unreachable",
      detail: expect.stringContaining("adb reverse tcp:9123 tcp:9123"),
    });
  });

  it.each([undefined, 25])("aborts an unresponsive probe after timeout %s", async (timeoutMs) => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("Aborted")), {
            once: true,
          });
        }),
    );
    const result = probeBridge("http://localhost:9123", { fetchImpl, timeoutMs });
    await vi.advanceTimersByTimeAsync(timeoutMs ?? 4000);
    await expect(result).resolves.toMatchObject({ ok: false, kind: "unreachable" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
