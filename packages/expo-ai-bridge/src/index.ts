import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { z } from "zod";
import { matchesControlSecret, writeControlFile } from "./control.js";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  decodeClientMessage,
  encodeServerMessage,
  LIMITS,
  PairRequestSchema,
  PROTOCOL_VERSION,
} from "@dave-morgan/expo-ai-protocol";
import type { ClientMessage, ServerMessageInput } from "@dave-morgan/expo-ai-protocol";
import { T3CliAdapter } from "@dave-morgan/expo-ai-t3-adapter";
import type { AgentAdapter, AgentThread } from "@dave-morgan/expo-ai-t3-adapter";
import type { BridgeConfig, BridgeProject } from "./config.js";
import { isLoopbackHost } from "./config.js";
import { PairingManager, PairingError } from "./pairing.js";
import { FeedbackPipeline } from "./pipeline.js";
import type { WatcherFactory } from "./pipeline.js";
export * from "./config.js";
export * from "./prompt.js";
const { version } = z
  .object({ version: z.string() })
  .parse(createRequire(import.meta.url)("../package.json"));

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}
interface Session {
  project: BridgeProject;
  clientId: string;
  device: Extract<ClientMessage, { type: "hello" }>["device"];
}

export function createBridge(
  config: BridgeConfig,
  deps: {
    adapter?: AgentAdapter;
    logger?: Logger;
    now?: () => number;
    watcherFactory?: WatcherFactory;
  } = {},
) {
  const logger = deps.logger ?? console;
  const adapter =
    deps.adapter ??
    new T3CliAdapter({
      cli: config.t3.command ? { command: config.t3.command, args: config.t3.args } : undefined,
      timeoutMs: config.t3.timeoutMs,
    });
  const now = deps.now ?? Date.now;
  const selected = new Map(config.projects.map((p) => [p.id, p.defaultThreadId ?? null]));
  const sessions = new Map<WebSocket, Session>();
  const alive = new Map<WebSocket, boolean>();
  const pending = new Set<Promise<void>>();
  let pairing: PairingManager;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let started = false;
  const controlSecret = randomBytes(32).toString("base64url");
  let removeControl: (() => Promise<void>) | undefined;
  const send = (ws: WebSocket, message: ServerMessageInput) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(encodeServerMessage(message));
  };
  const pipeline = new FeedbackPipeline(
    config,
    adapter,
    (project, status) => {
      for (const [ws, session] of sessions) if (session.project.id === project) send(ws, status);
    },
    now,
    deps.watcherFactory,
  );
  const server = createServer((req, res) => {
    void http(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { error: "internal" });
      else res.end();
    });
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxFrameBytes });
  function json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }
  async function http(req: IncomingMessage, res: ServerResponse) {
    if (req.method === "GET" && req.url === "/health") {
      json(res, 200, {
        ok: true,
        name: "expo-ai-bridge",
        version,
        protocolVersion: PROTOCOL_VERSION,
      });
      return;
    }
    if (req.method === "POST" && req.url === "/control/pairing-code") {
      const address = req.socket.remoteAddress?.replace(/^::ffff:/i, "") ?? "";
      const secret = req.headers["x-expo-ai-control"];
      if (
        !isLoopbackHost(address) ||
        typeof secret !== "string" ||
        !matchesControlSecret(secret, controlSecret)
      ) {
        json(res, 404, { error: "not_found" });
        return;
      }
      json(res, 200, pairing.regeneratePairingCode());
      return;
    }
    if (req.method !== "POST" || req.url !== "/pair") {
      json(res, 404, { error: "not_found" });
      return;
    }
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of req) {
      length += Buffer.byteLength(chunk);
      if (length > 4096) {
        json(res, 413, { error: "payload_too_large" });
        return;
      }
      chunks.push(Buffer.from(chunk));
    }
    let raw: unknown;
    try {
      raw = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      json(res, 400, { error: "invalid_message" });
      return;
    }
    const parsed = PairRequestSchema.safeParse(raw);
    if (!parsed.success) {
      json(res, 400, { error: "invalid_message" });
      return;
    }
    try {
      json(res, 200, await pairing.pair(parsed.data, req.socket.remoteAddress ?? "unknown"));
    } catch (error) {
      if (error instanceof PairingError) json(res, error.status, { error: error.code });
      else throw error;
    }
  }
  async function threads(ws: WebSocket, project: BridgeProject): Promise<AgentThread[]> {
    try {
      const list = (await adapter.listThreads(project.t3Project)).filter(
        (t) => !project.allowedThreadIds || project.allowedThreadIds.includes(t.threadId),
      );
      const current = selected.get(project.id) ?? null;
      if (current && !list.some((t) => t.threadId === current)) selected.set(project.id, null);
      send(ws, {
        type: "threads",
        threads: list,
        selectedThreadId: selected.get(project.id) ?? null,
      });
      return list;
    } catch (error) {
      send(ws, {
        type: "threads",
        threads: [],
        selectedThreadId: selected.get(project.id) ?? null,
        error: error instanceof Error ? error.message : "Adapter unavailable",
      });
      return [];
    }
  }
  function fail(
    ws: WebSocket,
    code: Extract<ServerMessageInput, { type: "error" }>["code"],
    message: string,
    close?: number,
  ) {
    send(ws, { type: "error", code, message, fatal: close !== undefined });
    if (close) ws.close(close);
  }
  async function handle(ws: WebSocket, message: ClientMessage) {
    const session = sessions.get(ws);
    if (!session) {
      if (message.type !== "hello") {
        fail(ws, "unauthorized", "First message must be hello", 4401);
        return;
      }
      if (message.protocolVersion !== PROTOCOL_VERSION) {
        fail(ws, "unsupported_version", "Unsupported protocol version", 4400);
        return;
      }
      const auth = pairing.authenticate(message.token, message.projectId, message.clientId);
      if (!auth) {
        fail(ws, "unauthorized", "Invalid or expired pairing token", 4401);
        return;
      }
      const project = config.projects.find((p) => p.id === message.projectId);
      if (!project) {
        fail(ws, "unauthorized", "Invalid project", 4401);
        return;
      }
      sessions.set(ws, { project, clientId: message.clientId, device: message.device });
      send(ws, {
        type: "welcome",
        protocolVersion: PROTOCOL_VERSION,
        bridgeVersion: version,
        sessionId: message.clientId,
        project: { id: project.id, name: project.name },
        selectedThreadId: selected.get(project.id) ?? null,
        capabilities: adapter.capabilities(),
        screenshotsAccepted: config.screenshots.enabled,
      });
      await threads(ws, project);
      for (const status of pipeline.replay(project.id, message.clientId)) send(ws, status);
      return;
    }
    const project = session.project;
    switch (message.type) {
      case "hello":
        fail(ws, "invalid_message", "Already authenticated");
        break;
      case "ping":
        send(ws, { type: "pong", at: message.at });
        break;
      case "threads.list":
        await threads(ws, project);
        break;
      case "threads.select": {
        const list = await adapter.listThreads(project.t3Project);
        if (
          !list.some((t) => t.threadId === message.threadId) ||
          (project.allowedThreadIds && !project.allowedThreadIds.includes(message.threadId))
        ) {
          fail(ws, "invalid_message", "Thread is not available for this project");
          break;
        }
        selected.set(project.id, message.threadId);
        for (const [peer, s] of sessions)
          if (s.project.id === project.id)
            send(peer, {
              type: "threads",
              threads: list.filter(
                (t) => !project.allowedThreadIds || project.allowedThreadIds.includes(t.threadId),
              ),
              selectedThreadId: message.threadId,
            });
        break;
      }
      case "feedback.submit": {
        const feedback = message.feedback;
        const reject = (reason: string) =>
          send(ws, {
            type: "feedback.ack",
            requestId: feedback.requestId,
            result: "rejected",
            reason,
          });
        if (feedback.projectId !== project.id) {
          reject("Project does not match session");
          break;
        }
        const threadId = feedback.threadId ?? selected.get(project.id);
        if (!threadId) {
          reject("No thread selected");
          fail(ws, "no_thread_selected", "Select a thread before submitting");
          break;
        }
        if (project.allowedThreadIds && !project.allowedThreadIds.includes(threadId)) {
          reject("Thread is not allowed");
          break;
        }
        // Validate the target against the configured project, including explicit thread overrides.
        // A previously selected target remains usable during CLI outages so retrying is possible.
        try {
          const list = await adapter.listThreads(project.t3Project);
          if (!list.some((t) => t.threadId === threadId)) {
            reject("Thread is not available for this project");
            break;
          }
        } catch {
          if (threadId !== selected.get(project.id)) {
            reject("Unable to validate target thread");
            break;
          }
        }
        const ack = pipeline.submit(feedback, session.clientId, threadId, session.device);
        send(ws, ack);
        if (ack.result === "duplicate") {
          const status = pipeline.latest(project.id, feedback.requestId);
          if (status) send(ws, status);
        }
        break;
      }
      case "feedback.cancel":
        if (!pipeline.cancel(project.id, message.requestId))
          fail(ws, "invalid_message", "already delivered to T3; cancel it in T3 Code");
        break;
      case "refresh.event":
        pipeline.refresh(project.id, message.kind, message.message);
        break;
    }
  }
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  wss.on("connection", (ws) => {
    alive.set(ws, true);
    const timeout = setTimeout(() => {
      if (!sessions.has(ws)) ws.close(4408, "hello timeout");
    }, 10000);
    let chain = Promise.resolve();
    ws.on("pong", () => alive.set(ws, true));
    ws.on("error", () => {});
    ws.on("close", () => {
      clearTimeout(timeout);
      alive.delete(ws);
      sessions.delete(ws);
    });
    ws.on("message", (data, isBinary) => {
      chain = chain
        .then(async () => {
          if (isBinary) {
            fail(ws, "invalid_message", "Expected a JSON text frame");
            return;
          }
          const decoded = decodeClientMessage(data.toString());
          if (!decoded.ok) {
            fail(ws, "invalid_message", decoded.error);
            return;
          }
          await handle(ws, decoded.value);
          if (sessions.has(ws)) clearTimeout(timeout);
        })
        .catch(() =>
          fail(ws, "adapter_unavailable", "T3 Code is unavailable; start T3 Code or t3 serve"),
        );
      const task = chain;
      pending.add(task);
      void task.finally(() => pending.delete(task));
    });
  });
  return {
    async start() {
      if (started) throw new Error("Bridge already started");
      pairing = await PairingManager.create({
        config: config.pairing,
        projectIds: config.projects.map((p) => p.id),
        now,
        onCodeRotated: ({ code, expiresAt }) =>
          logger.info(`Pairing code: ${code} (expires ${expiresAt.toISOString()})`),
        onCodeInvalidated: () =>
          logger.warn("Pairing code invalidated after ten failures; generate a new code with p"),
      });
      if (!isLoopbackHost(config.host))
        logger.warn(
          "bridge reachable from your network; pairing token required; never expose to the internet",
        );
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      started = true;
      heartbeat = setInterval(() => {
        for (const [ws, value] of alive) {
          if (!value) {
            ws.terminate();
            continue;
          }
          alive.set(ws, false);
          ws.ping();
        }
      }, 20000);
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No listening address");
      try {
        removeControl = await writeControlFile(config, address.port, controlSecret);
      } catch (error) {
        await this.stop();
        throw error;
      }
      pairing.startAutoRotation();
      return { port: address.port, host: config.host };
    },
    async stop() {
      pairing?.stopAutoRotation();
      pipeline.stop();
      if (heartbeat) clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      await Promise.allSettled([...pending]);
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      if (started)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      started = false;
      await removeControl?.();
      removeControl = undefined;
    },
    getPairingCode() {
      if (!pairing) throw new Error("Start bridge first");
      return pairing.getPairingCode();
    },
    regeneratePairingCode() {
      if (!pairing) throw new Error("Start bridge first");
      return pairing.regeneratePairingCode();
    },
  };
}
