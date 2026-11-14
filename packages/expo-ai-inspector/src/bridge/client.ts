import {
  decodeServerMessage,
  encodeClientMessage,
  PROTOCOL_VERSION,
  type AdapterCapabilities,
  type ClientMessageInput,
  type DeviceInfo,
  type FeedbackInput,
  type ServerMessage,
  type ThreadSummary,
} from "@dave-morgan/expo-ai-protocol";

export type { FeedbackInput };

export type BridgeProbe =
  | { ok: true; url: string; version: string; protocolVersion: number }
  | { ok: false; url: string; kind: "unreachable" | "not_bridge" | "incompatible"; detail: string };

export class BridgePairError extends Error {
  constructor(
    message: string,
    public readonly kind: "unreachable" | "not_bridge" | "incompatible" | "rejected",
    public readonly url: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "BridgePairError";
  }
}

function normalizeBridgeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function reverseHint(url: string): string {
  try {
    const parsed = new URL(url);
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    return `adb reverse tcp:${port} tcp:${port}`;
  } catch {
    return "adb reverse tcp:<bridge-port> tcp:<bridge-port>";
  }
}

function unreachableDetail(url: string, error?: unknown): string {
  const reason = error instanceof Error ? `: ${error.message}` : "";
  return `Cannot reach bridge at ${url}${reason}. Check that the bridge is running and the device can reach it. For Android over USB, run ${reverseHint(url)}.`;
}

function notBridgeDetail(url: string, status?: number): string {
  const response = status === undefined ? "" : ` (HTTP ${status})`;
  return `${url}${response} did not respond as expo-ai-bridge. Check the bridge URL and the phone's proxy with adb shell settings get global http_proxy. For Android over USB, run ${reverseHint(url)}.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function probeBridge(
  url: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<BridgeProbe> {
  url = normalizeBridgeUrl(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 4000);
  try {
    const response = await (opts.fetchImpl ?? fetch)(`${url}/health`, {
      method: "GET",
      signal: controller.signal,
    });
    if (!response.ok)
      return { ok: false, url, kind: "not_bridge", detail: notBridgeDetail(url, response.status) };
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      if (controller.signal.aborted)
        return { ok: false, url, kind: "unreachable", detail: unreachableDetail(url) };
      return { ok: false, url, kind: "not_bridge", detail: notBridgeDetail(url) };
    }
    if (
      !isRecord(body) ||
      body.name !== "expo-ai-bridge" ||
      typeof body.version !== "string" ||
      typeof body.protocolVersion !== "number"
    ) {
      return { ok: false, url, kind: "not_bridge", detail: notBridgeDetail(url) };
    }
    if (body.protocolVersion !== PROTOCOL_VERSION) {
      return {
        ok: false,
        url,
        kind: "incompatible",
        detail: `Bridge protocol ${body.protocolVersion} is incompatible with inspector protocol ${PROTOCOL_VERSION}. Update the bridge and inspector to matching versions.`,
      };
    }
    return { ok: true, url, version: body.version, protocolVersion: body.protocolVersion };
  } catch (error) {
    return { ok: false, url, kind: "unreachable", detail: unreachableDetail(url, error) };
  } finally {
    clearTimeout(timeout);
  }
}

function pairingRejection(code: string, projectId: string, message?: string): string {
  switch (code) {
    case "unauthorized":
      return "The pairing code is invalid or expired. Press p in the bridge terminal or run expo-ai-bridge pair-code for a fresh code.";
    case "rate_limited":
      return "Too many pairing attempts. Wait a minute, then try again.";
    case "unknown_project":
      return `Unknown project "${projectId}". Match the inspector projectId to projects[].id in expo-ai-bridge.config.json.`;
    case "invalid_message":
      return "The bridge rejected the pairing request format. Check the projectId and clientId and update the bridge and inspector to matching versions.";
    default:
      return message ?? `Pairing rejected by the bridge (${code}).`;
  }
}

export type ConnectionState =
  | { status: "idle" }
  | { status: "unpaired"; reason?: string }
  | { status: "connecting"; attempt: number }
  | {
      status: "connected";
      projectName: string;
      capabilities: AdapterCapabilities;
      screenshotsAccepted: boolean;
    }
  | { status: "disconnected"; retryInMs: number; reason?: string }
  | { status: "failed"; reason: string };

export interface TokenStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface BridgeClientOptions {
  /** e.g. `http://192.168.1.20:8790`. The WebSocket URL is derived from it. */
  bridgeUrl: string;
  projectId: string;
  clientId: string;
  device: DeviceInfo;
  inspectorVersion?: string;
  tokenStore: TokenStore;
  createSocket?: (url: string) => WebSocketLike;
  fetchImpl?: typeof fetch;
  /** Backoff bounds for reconnects. */
  minRetryMs?: number;
  maxRetryMs?: number;
  heartbeatMs?: number;
}

type Listener<T> = (value: T) => void;

export interface BridgeEvents {
  state: ConnectionState;
  threads: { threads: ThreadSummary[]; selectedThreadId: string | null; error?: string };
  message: ServerMessage;
}

const OPEN = 1;

/**
 * WebSocket client for expo-ai-bridge: pairing, authenticated handshake, reconnect with
 * exponential backoff, an outbox that survives disconnects, and typed events.
 * Platform-agnostic so it can be unit-tested with a fake socket.
 */
export class BridgeClient {
  private socket: WebSocketLike | null = null;
  private state: ConnectionState = { status: "idle" };
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private stopped = true;
  private outbox: ClientMessageInput[] = [];
  /** Session tokens are bound to the client id used when pairing, so it is persisted with them. */
  private clientId: string;
  private listeners: { [K in keyof BridgeEvents]: Set<Listener<BridgeEvents[K]>> } = {
    state: new Set(),
    threads: new Set(),
    message: new Set(),
  };

  constructor(private readonly options: BridgeClientOptions) {
    this.clientId = options.clientId;
  }

  private get clientIdKey(): string {
    return `${this.tokenKey}.clientId`;
  }

  get tokenKey(): string {
    return `expo-ai-inspector.token.${this.options.projectId}.${this.options.bridgeUrl.replace(/[^A-Za-z0-9]/g, "_")}`;
  }

  get wsUrl(): string {
    return this.options.bridgeUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/ws";
  }

  getState(): ConnectionState {
    return this.state;
  }

  on<K extends keyof BridgeEvents>(event: K, listener: Listener<BridgeEvents[K]>): () => void {
    this.listeners[event].add(listener);
    return () => this.listeners[event].delete(listener);
  }

  private emit<K extends keyof BridgeEvents>(event: K, value: BridgeEvents[K]): void {
    for (const listener of this.listeners[event]) {
      try {
        listener(value);
      } catch {
        // listeners must not break the client
      }
    }
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    this.emit("state", state);
  }

  async start(): Promise<void> {
    this.stopped = false;
    const storedClientId = await this.options.tokenStore.get(this.clientIdKey);
    if (storedClientId) this.clientId = storedClientId;
    const token = await this.options.tokenStore.get(this.tokenKey);
    if (!token) {
      this.setState({ status: "unpaired" });
      return;
    }
    this.open(token);
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.close(1000, "inspector stopped");
    }
    this.setState({ status: "idle" });
  }

  /** Exchanges a 6-digit pairing code shown by the bridge for a session token. */
  async pair(code: string, deviceName?: string): Promise<void> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const probe = await probeBridge(this.options.bridgeUrl, { fetchImpl });
    if (!probe.ok) throw new BridgePairError(probe.detail, probe.kind, probe.url);
    const url = probe.url;
    let response: Response;
    try {
      response = await fetchImpl(url + "/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: code.trim(),
          projectId: this.options.projectId,
          clientId: this.clientId,
          ...(deviceName ? { deviceName } : {}),
        }),
      });
    } catch (error) {
      throw new BridgePairError(unreachableDetail(url, error), "unreachable", url);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new BridgePairError(notBridgeDetail(url, response.status), "not_bridge", url);
    }
    if (!isRecord(body))
      throw new BridgePairError(notBridgeDetail(url, response.status), "not_bridge", url);
    if (!response.ok || typeof body.token !== "string" || !body.token) {
      if (typeof body.error !== "string" || !body.error)
        throw new BridgePairError(notBridgeDetail(url, response.status), "not_bridge", url);
      throw new BridgePairError(
        pairingRejection(
          body.error,
          this.options.projectId,
          typeof body.message === "string" ? body.message : undefined,
        ),
        "rejected",
        url,
        body.error,
      );
    }
    await this.options.tokenStore.set(this.clientIdKey, this.clientId);
    await this.options.tokenStore.set(this.tokenKey, body.token);
    this.stopped = false;
    this.clearTimers();
    this.open(body.token);
  }

  async unpair(): Promise<void> {
    await this.options.tokenStore.delete(this.tokenKey);
    this.stop();
    this.stopped = false;
    this.setState({ status: "unpaired" });
  }

  /** Queues while disconnected; the bridge deduplicates by requestId so resends are safe. */
  send(message: ClientMessageInput): void {
    // Validate eagerly so programming errors surface at the call site.
    const frame = encodeClientMessage(message);
    if (this.socket && this.socket.readyState === OPEN && this.state.status === "connected") {
      this.socket.send(frame);
    } else if (
      message.type === "feedback.submit" ||
      message.type === "feedback.cancel" ||
      message.type === "refresh.event"
    ) {
      this.outbox.push(message);
    }
  }

  submit(feedback: FeedbackInput): void {
    this.send({ type: "feedback.submit", feedback });
  }

  private open(token: string): void {
    if (this.stopped) return;
    this.attempt += 1;
    this.setState({ status: "connecting", attempt: this.attempt });
    const create =
      this.options.createSocket ??
      ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
    let socket: WebSocketLike;
    try {
      socket = create(this.wsUrl);
    } catch (error) {
      this.scheduleReconnect((error as Error).message);
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      socket.send(
        encodeClientMessage({
          type: "hello",
          protocolVersion: PROTOCOL_VERSION,
          token,
          projectId: this.options.projectId,
          clientId: this.clientId,
          device: this.options.device,
          ...(this.options.inspectorVersion
            ? { inspectorVersion: this.options.inspectorVersion }
            : {}),
        }),
      );
    };
    socket.onmessage = (event) => this.handleFrame(event.data);
    socket.onerror = () => {
      // onclose follows; nothing to do here
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearHeartbeat();
      if (this.stopped || this.state.status === "unpaired" || this.state.status === "failed")
        return;
      this.scheduleReconnect(event.reason || (event.code ? `closed (${event.code})` : undefined));
    };
  }

  private handleFrame(data: unknown): void {
    const decoded = decodeServerMessage(typeof data === "string" ? data : String(data));
    if (!decoded.ok) return;
    const message = decoded.value;
    switch (message.type) {
      case "welcome":
        this.attempt = 0;
        this.setState({
          status: "connected",
          projectName: message.project.name,
          capabilities: message.capabilities,
          screenshotsAccepted: message.screenshotsAccepted,
        });
        this.startHeartbeat();
        this.flushOutbox();
        break;
      case "threads":
        this.emit("threads", {
          threads: message.threads,
          selectedThreadId: message.selectedThreadId,
          ...(message.error ? { error: message.error } : {}),
        });
        break;
      case "error":
        if (message.fatal) {
          if (message.code === "unauthorized") {
            void this.options.tokenStore.delete(this.tokenKey);
            this.setState({ status: "unpaired", reason: message.message });
          } else {
            this.setState({ status: "failed", reason: message.message });
          }
          this.clearTimers();
          this.socket?.close(1000);
          this.socket = null;
        }
        break;
      default:
        break;
    }
    this.emit("message", message);
  }

  private flushOutbox(): void {
    const pending = this.outbox;
    this.outbox = [];
    for (const message of pending) this.send(message);
  }

  private scheduleReconnect(reason?: string): void {
    const min = this.options.minRetryMs ?? 1000;
    const max = this.options.maxRetryMs ?? 15000;
    const delay = Math.min(max, min * 2 ** Math.min(this.attempt, 6));
    this.setState({ status: "disconnected", retryInMs: delay, ...(reason ? { reason } : {}) });
    this.retryTimer = setTimeout(async () => {
      this.retryTimer = null;
      const token = await this.options.tokenStore.get(this.tokenKey);
      if (!token) this.setState({ status: "unpaired" });
      else this.open(token);
    }, delay);
  }

  /** Reconnect immediately (e.g. user tapped "retry"). */
  async reconnect(): Promise<void> {
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.close(1000);
    }
    this.attempt = 0;
    await this.start();
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    const every = this.options.heartbeatMs ?? 15000;
    this.heartbeat = setInterval(() => this.send({ type: "ping", at: Date.now() }), every);
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private clearTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.clearHeartbeat();
  }
}

export class MemoryTokenStore implements TokenStore {
  private values = new Map<string, string>();
  async get(key: string) {
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.values.set(key, value);
  }
  async delete(key: string) {
    this.values.delete(key);
  }
}
