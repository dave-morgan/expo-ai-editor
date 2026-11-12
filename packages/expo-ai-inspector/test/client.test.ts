import { decodeClientMessage, encodeServerMessage, type ClientMessage } from "@expo-ai/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeClient, MemoryTokenStore, type ConnectionState, type WebSocketLike } from "../src/bridge/client";

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
  capabilities: { adapter: "t3-cli", listThreads: true, queue: true, steer: false, attachments: false, runStatus: true },
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
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ code: "123456", projectId: "example-expo", clientId: "client-1" });
      return new Response(JSON.stringify({ token: "t".repeat(43), expiresAt: "x", projectId: "example-expo" }), { status: 200 });
    });
    const { client, tokens, states } = createClient(new MemoryTokenStore(), fetchImpl as unknown as typeof fetch);
    await client.pair("123456");
    expect(fetchImpl.mock.calls[0]![0]).toBe("http://192.168.1.20:8790/pair");
    expect(await tokens.get(client.tokenKey)).toBe("t".repeat(43));
    const socket = FakeSocket.instances[0]!;
    expect(socket.url).toBe("ws://192.168.1.20:8790/ws");
    socket.open();
    expect(socket.sent[0]).toMatchObject({ type: "hello", token: "t".repeat(43), projectId: "example-expo", protocolVersion: 1 });
    socket.receive(welcome);
    expect(states.at(-1)).toMatchObject({ status: "connected", projectName: "Example" });
  });

  it("reuses the paired client id after an app reload (tokens are bound to it)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ token: "t".repeat(43), expiresAt: "x", projectId: "example-expo" }), { status: 200 }));
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
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "invalid_code", message: "Invalid pairing code" }), { status: 401 }));
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
    socket.receive({ type: "threads", threads: [{ threadId: "t1", title: "Main", status: "idle" }], selectedThreadId: "t1" });
    socket.receive({ type: "request.status", requestId: "req_00000001", phase: "agent_working", at: "now" });
    expect(threads).toHaveBeenCalledWith({ threads: [{ threadId: "t1", title: "Main", status: "idle" }], selectedThreadId: "t1" });
    expect(messages.mock.calls.map(([m]) => m.type)).toEqual(["welcome", "threads", "request.status"]);
  });

  it("rejects invalid outgoing messages at the call site", () => {
    const { client } = createClient();
    expect(() => client.submit({ ...feedback, threadId: "bad id; rm" })).toThrow();
  });
});
