import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  decodeServerMessage,
  encodeClientMessage,
  LIMITS,
  PairResponseSchema,
  PROTOCOL_VERSION,
} from "@expo-ai/protocol";
import type { ClientMessageInput, Feedback, ServerMessage } from "@expo-ai/protocol";
import { T3CliAdapter } from "@expo-ai/t3-adapter";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { z } from "zod";

import type { BridgeConfig } from "../src/config.js";
import { createBridge } from "../src/index.js";

const fixture = fileURLToPath(
  new URL("../../t3-adapter/test/fixtures/fake-t3.mjs", import.meta.url),
);
const threadId = "mcp:integration-thread";
const projectId = "integration-project";
const clientId = "integration-device";

class InspectorClient {
  readonly socket: WebSocket;
  readonly messages: ServerMessage[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on("message", (data) => {
      const parsed = decodeServerMessage(data.toString());
      if (!parsed.ok) throw new Error(`Bridge emitted an invalid protocol frame: ${parsed.error}`);
      this.messages.push(parsed.value);
      for (const listener of this.listeners) listener();
    });
  }

  async open(): Promise<void> {
    await once(this.socket, "open");
  }

  send(message: ClientMessageInput): void {
    this.socket.send(encodeClientMessage(message));
  }

  async waitFor(
    predicate: (message: ServerMessage) => boolean,
    from = 0,
    timeoutMs = 15000,
  ): Promise<ServerMessage> {
    const existing = this.messages.slice(from).find(predicate);
    if (existing) return existing;
    return new Promise((resolveMessage, rejectMessage) => {
      const timeout = setTimeout(() => {
        this.listeners.delete(check);
        rejectMessage(
          new Error(
            `Timed out waiting for frame; received ${JSON.stringify(this.messages.slice(from))}`,
          ),
        );
      }, timeoutMs);
      const check = () => {
        const message = this.messages.slice(from).find(predicate);
        if (!message) return;
        clearTimeout(timeout);
        this.listeners.delete(check);
        resolveMessage(message);
      };
      this.listeners.add(check);
      check();
    });
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = once(this.socket, "close");
    this.socket.close();
    await closed;
  }
}

describe("bridge with the real T3 CLI adapter", { timeout: 20000 }, () => {
  let directory: string;
  let root: string;
  let stateFile: string;
  let bridge: ReturnType<typeof createBridge>;
  let httpUrl: string;
  let wsUrl: string;
  let clients: InspectorClient[];

  async function updateState(patch: Record<string, unknown>): Promise<void> {
    const lock = `${stateFile}.lock`;
    for (let attempt = 0; ; attempt++) {
      try {
        await mkdir(lock);
        break;
      } catch (error) {
        if (
          !(error instanceof Error && "code" in error && error.code === "EEXIST") ||
          attempt >= 1000
        )
          throw error;
        await delay(5);
      }
    }
    try {
      const current: unknown = JSON.parse(await readFile(stateFile, "utf8"));
      if (typeof current !== "object" || current === null || Array.isArray(current))
        throw new Error("Invalid fixture state");
      await writeFile(stateFile, JSON.stringify({ ...current, ...patch }));
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }

  async function pair(targetProject = projectId) {
    return fetch(`${httpUrl}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: bridge.getPairingCode().code,
        projectId: targetProject,
        clientId,
        deviceName: "Test phone",
      }),
    });
  }

  async function connect(token?: string): Promise<{ client: InspectorClient; token: string }> {
    const sessionToken = token ?? PairResponseSchema.parse(await (await pair()).json()).token;
    const client = new InspectorClient(wsUrl);
    clients.push(client);
    await client.open();
    client.send({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      token: sessionToken,
      projectId,
      clientId,
      device: { platform: "ios" },
    });
    await client.waitFor((message) => message.type === "welcome");
    await client.waitFor((message) => message.type === "threads");
    return { client, token: sessionToken };
  }

  function feedback(requestId: string, instruction = `Change requested by ${requestId}`): Feedback {
    return {
      requestId,
      projectId,
      threadId,
      instruction,
      inputMethod: "typed",
      mode: "queue",
      createdAt: new Date().toISOString(),
    };
  }

  function status(
    client: InspectorClient,
    requestId: string,
    phase: string,
    from = 0,
  ): Promise<ServerMessage> {
    return client.waitFor(
      (message) =>
        message.type === "request.status" &&
        message.requestId === requestId &&
        message.phase === phase,
      from,
    );
  }

  beforeEach(async () => {
    clients = [];
    directory = await mkdtemp(join(tmpdir(), "expo-ai-bridge-integration-"));
    root = join(directory, "project");
    await mkdir(root);
    stateFile = join(directory, "fake-t3-state.json");
    await writeFile(
      stateFile,
      JSON.stringify({
        mode: "ok",
        autoComplete: true,
        completeAfterShows: 4,
        threads: [
          {
            threadId,
            projectId,
            title: "Integration thread",
            status: "idle",
            activeRunId: null,
            latestRunId: null,
            pendingRequestCount: 0,
          },
        ],
        messages: {},
        runs: {},
      }),
    );
    const config: BridgeConfig = {
      host: "127.0.0.1",
      port: 0,
      projects: [
        {
          id: projectId,
          name: "Integration app",
          root,
          t3Project: projectId,
          allowedThreadIds: [threadId],
        },
      ],
      screenshots: { enabled: true, dir: ".expo-ai/screenshots", maxBytes: 4500000 },
      t3: { args: [], pollIntervalMs: 50, timeoutMs: 5000 },
      pairing: {
        codeTtlSeconds: 600,
        tokenTtlHours: 12,
        sessionsFile: join(directory, "sessions.json"),
      },
    };
    const adapter = new T3CliAdapter({
      cli: { command: process.execPath, args: [fixture] },
      env: { ...process.env, FAKE_T3_STATE: stateFile },
      timeoutMs: 5000,
    });
    bridge = createBridge(config, { adapter });
    const address = await bridge.start();
    httpUrl = `http://127.0.0.1:${address.port}`;
    wsUrl = `ws://127.0.0.1:${address.port}/ws`;
  });

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await bridge?.stop();
    await rm(directory, { recursive: true, force: true });
  });

  it("serves health without secrets and pairs before hello, listing and selecting an existing thread", async () => {
    const health = await fetch(`${httpUrl}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      ok: true,
      name: "expo-ai-bridge",
      version: expect.any(String),
      protocolVersion: PROTOCOL_VERSION,
    });
    const { client } = await connect();
    expect(client.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "welcome",
          project: { id: projectId, name: "Integration app" },
          capabilities: expect.objectContaining({ steer: false, queue: true }),
        }),
        expect.objectContaining({
          type: "threads",
          threads: [expect.objectContaining({ threadId })],
          selectedThreadId: null,
        }),
      ]),
    );
    const checkpoint = client.messages.length;
    client.send({ type: "threads.select", threadId });
    expect(
      await client.waitFor(
        (message) => message.type === "threads" && message.selectedThreadId === threadId,
        checkpoint,
      ),
    ).toMatchObject({ selectedThreadId: threadId });
  });

  it("delivers feedback on stdin and reports accepted, received, queued, submitted, working and completed in order", async () => {
    const { client } = await connect();
    client.send({ type: "threads.select", threadId });
    await client.waitFor(
      (message) => message.type === "threads" && message.selectedThreadId === threadId,
    );
    const request = feedback(
      "ordered-request",
      'Make the heading smaller. $(do not execute) & quotes: "hello"',
    );
    delete request.threadId;
    client.send({ type: "feedback.submit", feedback: request });
    await status(client, request.requestId, "agent_completed");
    const frames = client.messages.filter(
      (message) => "requestId" in message && message.requestId === request.requestId,
    );
    const ack = frames.findIndex(
      (message) => message.type === "feedback.ack" && message.result === "accepted",
    );
    const phases = ["received", "queued", "submitted", "agent_working", "agent_completed"];
    const positions = phases.map((phase) =>
      frames.findIndex((message) => message.type === "request.status" && message.phase === phase),
    );
    expect(ack).toBeGreaterThanOrEqual(0);
    expect(positions.every((position) => position > ack)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    const state = z
      .object({
        messages: z.record(z.string(), z.array(z.object({ role: z.string(), text: z.string() }))),
      })
      .parse(JSON.parse(await readFile(stateFile, "utf8")));
    const userMessage = state.messages[threadId]?.find((message) => message.role === "user");
    expect(userMessage?.text).toContain(JSON.stringify(request.instruction));
  });

  it("keeps the second run queued while the thread is busy, then observes both completions", async () => {
    await updateState({ autoComplete: false });
    const { client } = await connect();
    client.send({ type: "feedback.submit", feedback: feedback("busy-request-one") });
    await status(client, "busy-request-one", "agent_working");
    const checkpoint = client.messages.length;
    client.send({ type: "feedback.submit", feedback: feedback("busy-request-two") });
    await status(client, "busy-request-two", "queued", checkpoint);
    expect(
      client.messages.some(
        (message) =>
          message.type === "request.status" &&
          message.requestId === "busy-request-two" &&
          message.phase === "agent_working",
      ),
    ).toBe(false);
    await updateState({ autoComplete: true });
    await status(client, "busy-request-one", "agent_completed");
    await status(client, "busy-request-two", "submitted");
    await status(client, "busy-request-two", "agent_completed");
  });

  it("deduplicates repeated request ids and replays their latest status", async () => {
    const { client } = await connect();
    const request = feedback("duplicate-request");
    client.send({ type: "feedback.submit", feedback: request });
    await status(client, request.requestId, "agent_completed");
    const checkpoint = client.messages.length;
    client.send({ type: "feedback.submit", feedback: request });
    await client.waitFor(
      (message) =>
        message.type === "feedback.ack" &&
        message.requestId === request.requestId &&
        message.result === "duplicate",
      checkpoint,
    );
    await status(client, request.requestId, "agent_completed", checkpoint);
  });

  it("rejects unauthorized hello with a fatal error and close code 4401", async () => {
    const client = new InspectorClient(wsUrl);
    clients.push(client);
    await client.open();
    const closeCode = new Promise<number>((resolveCode) =>
      client.socket.once("close", resolveCode),
    );
    client.send({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      token: "invalid-token-at-least-sixteen-chars",
      projectId,
      clientId,
      device: { platform: "ios" },
    });
    expect(await client.waitFor((message) => message.type === "error")).toMatchObject({
      code: "unauthorized",
      fatal: true,
    });
    expect(await closeCode).toBe(4401);
  });

  it("rejects pairing for an unknown project", async () => {
    const response = await pair("unknown-project");
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("unknown_project");
  });

  it("rejects unsupported protocol versions with close code 4400", async () => {
    const token = PairResponseSchema.parse(await (await pair()).json()).token;
    const client = new InspectorClient(wsUrl);
    clients.push(client);
    await client.open();
    const closeCode = new Promise<number>((resolveCode) =>
      client.socket.once("close", resolveCode),
    );
    client.send({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION + 1,
      token,
      projectId,
      clientId,
      device: { platform: "ios" },
    });
    expect(await client.waitFor((message) => message.type === "error")).toMatchObject({
      code: "unsupported_version",
      fatal: true,
    });
    expect(await closeCode).toBe(4400);
  });

  it("rejects a valid token used for a different project", async () => {
    const token = PairResponseSchema.parse(await (await pair()).json()).token;
    const client = new InspectorClient(wsUrl);
    clients.push(client);
    await client.open();
    const closeCode = new Promise<number>((resolveCode) =>
      client.socket.once("close", resolveCode),
    );
    client.send({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      token,
      projectId: "other-project",
      clientId,
      device: { platform: "ios" },
    });
    expect(await client.waitFor((message) => message.type === "error")).toMatchObject({
      code: "unauthorized",
      fatal: true,
    });
    expect(await closeCode).toBe(4401);
  });

  it("requires hello as the first frame", async () => {
    const client = new InspectorClient(wsUrl);
    clients.push(client);
    await client.open();
    const closeCode = new Promise<number>((resolveCode) =>
      client.socket.once("close", resolveCode),
    );
    client.send({ type: "ping", at: 1 });
    expect(await client.waitFor((message) => message.type === "error")).toMatchObject({
      code: "unauthorized",
      fatal: true,
    });
    expect(await closeCode).toBe(4401);
  });

  it("rejects feedback when no thread has been selected", async () => {
    const { client } = await connect();
    const request = feedback("no-thread-request");
    delete request.threadId;
    client.send({ type: "feedback.submit", feedback: request });
    expect(
      await client.waitFor(
        (message) => message.type === "feedback.ack" && message.requestId === request.requestId,
      ),
    ).toMatchObject({ result: "rejected" });
    expect(await client.waitFor((message) => message.type === "error")).toMatchObject({
      code: "no_thread_selected",
      fatal: false,
    });
  });

  it("rejects feedback for a project outside the authenticated session", async () => {
    const { client } = await connect();
    const request = { ...feedback("other-project-request"), projectId: "other-project" };
    client.send({ type: "feedback.submit", feedback: request });
    expect(
      await client.waitFor(
        (message) => message.type === "feedback.ack" && message.requestId === request.requestId,
      ),
    ).toMatchObject({ result: "rejected" });
  });

  it("filters disallowed threads and rejects selecting or submitting to them", async () => {
    const blocked = "disallowed-thread";
    await updateState({
      threads: [
        {
          threadId,
          projectId,
          title: "Allowed",
          status: "idle",
          activeRunId: null,
          latestRunId: null,
          pendingRequestCount: 0,
        },
        {
          threadId: blocked,
          projectId,
          title: "Blocked",
          status: "idle",
          activeRunId: null,
          latestRunId: null,
          pendingRequestCount: 0,
        },
      ],
    });
    const { client } = await connect();
    expect(client.messages.find((message) => message.type === "threads")).toMatchObject({
      threads: [expect.objectContaining({ threadId })],
    });
    client.send({ type: "threads.select", threadId: blocked });
    expect(await client.waitFor((message) => message.type === "error")).toMatchObject({
      code: "invalid_message",
      fatal: false,
    });
    const request = { ...feedback("disallowed-request"), threadId: blocked };
    client.send({ type: "feedback.submit", feedback: request });
    expect(
      await client.waitFor(
        (message) => message.type === "feedback.ack" && message.requestId === request.requestId,
      ),
    ).toMatchObject({ result: "rejected" });
  });

  it("closes oversized WebSocket frames with code 1009", async () => {
    const { client } = await connect();
    const closeCode = new Promise<number>((resolveCode) =>
      client.socket.once("close", resolveCode),
    );
    client.socket.send("x".repeat(LIMITS.maxFrameBytes + 1));
    expect(await closeCode).toBe(1009);
  });

  it("reports invalid frames without closing the authenticated socket", async () => {
    const { client } = await connect();
    client.socket.send("this is not JSON");
    expect(await client.waitFor((message) => message.type === "error")).toMatchObject({
      code: "invalid_message",
      fatal: false,
    });
    client.send({ type: "ping", at: 123 });
    expect(await client.waitFor((message) => message.type === "pong")).toMatchObject({ at: 123 });
  });

  it("retries an unavailable T3 server and delivers when it returns", async () => {
    const { client } = await connect();
    client.send({ type: "threads.select", threadId });
    await client.waitFor(
      (message) => message.type === "threads" && message.selectedThreadId === threadId,
    );
    await updateState({ mode: "down" });
    client.send({ type: "feedback.submit", feedback: feedback("retry-request") });
    expect(
      await client.waitFor(
        (message) =>
          message.type === "request.status" &&
          message.requestId === "retry-request" &&
          message.phase === "queued" &&
          Boolean(message.detail?.includes("retrying")),
      ),
    ).toMatchObject({ detail: expect.stringContaining("retrying") });
    await updateState({ mode: "ok" });
    await status(client, "retry-request", "submitted");
    await status(client, "retry-request", "agent_completed");
  });

  it("replays a device's last status after reconnecting and continues monitoring", async () => {
    await updateState({ autoComplete: false });
    const first = await connect();
    first.client.send({ type: "feedback.submit", feedback: feedback("reconnect-request") });
    await status(first.client, "reconnect-request", "agent_working");
    await first.client.close();
    const second = await connect(first.token);
    await status(second.client, "reconnect-request", "agent_working");
    await updateState({ autoComplete: true });
    await status(second.client, "reconnect-request", "agent_completed");
  });

  it("observes real source writes, native configuration changes, and an inspector refresh", async () => {
    const { client } = await connect();
    client.send({ type: "feedback.submit", feedback: feedback("source-request") });
    await status(client, "source-request", "submitted");
    await writeFile(join(root, "Screen.tsx"), 'export const title = "Updated";\n');
    expect(
      await client.waitFor(
        (message) =>
          message.type === "request.status" &&
          message.phase === "source_changed" &&
          Boolean(message.changedFiles?.includes("Screen.tsx")),
      ),
    ).toMatchObject({
      requestId: "source-request",
      changedFiles: expect.arrayContaining(["Screen.tsx"]),
    });
    await writeFile(join(root, "app.json"), '{"expo":{"name":"Updated"}}\n');
    expect(await status(client, "source-request", "native_rebuild_required")).toMatchObject({
      detail: expect.stringContaining("app.json"),
    });
    client.send({ type: "refresh.event", kind: "applied", at: new Date().toISOString() });
    await status(client, "source-request", "refresh_observed");
  });
});
