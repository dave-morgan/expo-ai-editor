import { createHash } from "node:crypto";
import { relative } from "node:path";
import type { DeviceInfo, Feedback, RequestPhase, ServerMessage } from "@dave-morgan/expo-ai-protocol";
import { AdapterUnavailableError } from "@dave-morgan/expo-ai-t3-adapter";
import type { AgentAdapter } from "@dave-morgan/expo-ai-t3-adapter";
import type { BridgeConfig, BridgeProject } from "./config.js";
import { buildAgentPrompt } from "./prompt.js";
import { saveScreenshot } from "./screenshot.js";
import { createChangeWatcher, isNativeChange } from "./changes.js";

type Status = Extract<ServerMessage, { type: "request.status" }>;
type Ack = Extract<ServerMessage, { type: "feedback.ack" }>;
export type WatcherFactory = (
  root: string,
  callback: (filename: string | null) => void,
) => { close(): void };
interface Request {
  feedback: Feedback;
  clientId: string;
  threadId: string;
  project: BridgeProject;
  status: Status;
  updated: number;
  delivered: boolean;
  cancelled: boolean;
  sourceChanged: boolean;
  eligible: boolean;
  completedAt?: number;
  device?: DeviceInfo;
}

export class FeedbackPipeline {
  private requests = new Map<string, Request>();
  private seen = new Map<string, true>();
  private fingerprints = new Map<string, number>();
  private queues = new Map<string, Request[]>();
  private workers = new Set<string>();
  private watchers = new Map<string, { close(): void }>();
  /** Fast Refresh often lands before the debounced file watcher reports the change. */
  private pendingRefresh = new Map<string, { kind: "applied" | "full-reload" | "error"; message?: string; at: number }>();
  private sleepers = new Map<ReturnType<typeof setTimeout>, () => void>();
  private stopped = false;
  constructor(
    private config: BridgeConfig,
    private adapter: AgentAdapter,
    private broadcast: (project: string, status: Status) => void,
    private now: () => number = Date.now,
    private watcherFactory?: WatcherFactory,
  ) {}

  private key(project: string, id: string) {
    return `${project}/${id}`;
  }
  private prune() {
    for (const [key, request] of this.requests)
      if (this.now() - request.updated > 1800000) this.requests.delete(key);
    for (const [key, at] of this.fingerprints)
      if (this.now() - at >= 15000) this.fingerprints.delete(key);
  }
  latest(project: string, id: string) {
    this.prune();
    return this.requests.get(this.key(project, id))?.status;
  }
  replay(project: string, client: string) {
    this.prune();
    return [...this.requests.values()]
      .filter((r) => r.project.id === project && r.clientId === client)
      .map((r) => r.status);
  }
  private emit(r: Request, phase: RequestPhase, detail?: string, changedFiles?: string[]) {
    r.updated = this.now();
    r.status = {
      type: "request.status",
      requestId: r.feedback.requestId,
      threadId: r.threadId,
      phase,
      at: new Date(r.updated).toISOString(),
      detail: detail?.slice(0, 4000),
      changedFiles,
    };
    this.broadcast(r.project.id, r.status);
  }
  submit(feedback: Feedback, clientId: string, threadId: string, device?: DeviceInfo): Ack {
    this.prune();
    const key = this.key(feedback.projectId, feedback.requestId);
    if (this.seen.has(key)) {
      this.seen.delete(key);
      this.seen.set(key, true);
      return { type: "feedback.ack", requestId: feedback.requestId, result: "duplicate" };
    }
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          feedback.projectId,
          threadId,
          feedback.instruction,
          feedback.selection?.source?.file,
          feedback.selection?.source?.line,
          feedback.selection?.elementType,
        ]),
      )
      .digest("hex");
    if (this.fingerprints.has(fingerprint))
      return {
        type: "feedback.ack",
        requestId: feedback.requestId,
        result: "duplicate",
        reason: "Identical feedback submitted within 15 seconds",
      };
    const project = this.config.projects.find((p) => p.id === feedback.projectId);
    if (!project)
      return {
        type: "feedback.ack",
        requestId: feedback.requestId,
        result: "rejected",
        reason: "Unknown project",
      };
    this.seen.set(key, true);
    if (this.seen.size > 1000) this.seen.delete(this.seen.keys().next().value!);
    this.fingerprints.set(fingerprint, this.now());
    const request: Request = {
      feedback,
      clientId,
      threadId,
      project,
      device,
      updated: this.now(),
      delivered: false,
      cancelled: false,
      sourceChanged: false,
      eligible: false,
      status: {
        type: "request.status",
        requestId: feedback.requestId,
        threadId,
        phase: "received",
        at: new Date(this.now()).toISOString(),
      },
    };
    this.requests.set(key, request);
    // Defer delivery so the caller can send the acknowledgement first.
    queueMicrotask(() => {
      if (this.stopped || request.cancelled) return;
      this.emit(request, "received");
      this.emit(request, "queued");
      if (!this.watchers.has(project.id)) {
        try {
          this.watchers.set(
            project.id,
            createChangeWatcher({
              root: project.root,
              onChange: (files) => this.changed(project.id, files),
              watcherFactory: this.watcherFactory,
            }),
          );
        } catch {
          /* Delivery remains available if the OS cannot watch the project. */
        }
      }
      const queueKey = this.key(project.id, threadId);
      const queue = this.queues.get(queueKey) ?? [];
      queue.push(request);
      this.queues.set(queueKey, queue);
      void this.work(queueKey);
    });
    return { type: "feedback.ack", requestId: feedback.requestId, result: "accepted" };
  }
  cancel(project: string, id: string) {
    const r = this.requests.get(this.key(project, id));
    if (!r || r.delivered) return false;
    r.cancelled = true;
    this.emit(r, "cancelled");
    return true;
  }
  private async sleep(ms: number) {
    if (this.stopped) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.sleepers.delete(timer);
        resolve();
      }, ms);
      this.sleepers.set(timer, resolve);
    });
  }
  private async work(key: string) {
    if (this.workers.has(key)) return;
    this.workers.add(key);
    try {
      const queue = this.queues.get(key)!;
      while (queue.length && !this.stopped) {
        const r = queue.shift()!;
        if (r.cancelled) continue;
        try {
          await this.deliver(r);
        } catch (error) {
          if (!r.cancelled && !this.stopped)
            this.emit(r, "failed", error instanceof Error ? error.message : "Delivery failed");
        }
      }
    } finally {
      this.workers.delete(key);
    }
  }
  private async deliver(r: Request) {
    const screenshotPath = r.feedback.screenshot
      ? await saveScreenshot({
          projectRoot: r.project.root,
          requestId: r.feedback.requestId,
          screenshot: r.feedback.screenshot,
          config: this.config.screenshots,
        })
      : undefined;
    const note =
      r.feedback.screenshot && !this.config.screenshots.enabled
        ? "Screenshot dropped: screenshots are disabled."
        : undefined;
    const message = buildAgentPrompt({
      feedback: r.feedback,
      project: r.project,
      screenshotPath,
      appRootRelative: relative(process.cwd(), r.project.root).replaceAll("\\", "/") || ".",
      capabilitiesNote: note,
      device: r.device,
    });
    let backoff = 2000;
    const started = this.now();
    while (!this.stopped && !r.cancelled) {
      try {
        const result = await this.adapter.sendMessage({
          threadId: r.threadId,
          message,
          mode: r.feedback.mode,
        });
        r.delivered = true;
        r.eligible = true;
        const downgrade =
          r.feedback.mode !== "queue" && !this.adapter.capabilities().steer
            ? "steer is not supported by the T3 CLI; queued as next turn instead"
            : "";
        this.emit(
          r,
          "submitted",
          [`Delivery: ${result.delivery}`, downgrade, note].filter(Boolean).join("; "),
        );
        await this.monitor(r, result.runId);
        return;
      } catch (error) {
        if (!(error instanceof AdapterUnavailableError)) throw error;
        if (this.now() - started >= 600000) {
          this.emit(r, "failed", "T3 Code not reachable — gave up after 10 minutes");
          return;
        }
        if (r.cancelled || this.stopped) return;
        this.emit(r, "queued", "T3 Code not reachable — retrying");
        await this.sleep(Math.min(backoff, 600000 - (this.now() - started)));
        backoff = Math.min(backoff * 2, 30000);
      }
    }
  }
  private async monitor(r: Request, runId: string | null) {
    const started = this.now();
    let last: RequestPhase = "submitted";
    while (!this.stopped) {
      if (this.now() - started >= 3600000) {
        r.eligible = false;
        this.emit(r, "failed", "stopped monitoring");
        return;
      }
      try {
        const state = await this.adapter.getThread(r.threadId);
        if (this.stopped) return;
        const phase = this.adapter.classifyRun(state, runId);
        const mapped = {
          queued: "queued",
          working: "agent_working",
          waiting: "agent_waiting",
          completed: "agent_completed",
          failed: "agent_failed",
          unknown: undefined,
        } as const;
        const next = mapped[phase];
        if (next && next !== last) {
          this.emit(
            r,
            next,
            next === "agent_completed" ? state.lastAssistantMessage?.slice(0, 500) : undefined,
          );
          last = next;
        }
        if (phase === "completed" || phase === "failed") {
          r.eligible = false;
          if (phase === "completed") r.completedAt = this.now();
          return;
        }
      } catch (error) {
        if (!(error instanceof AdapterUnavailableError)) {
          r.eligible = false;
          this.emit(
            r,
            "agent_failed",
            error instanceof Error ? error.message : "Monitoring failed",
          );
          return;
        }
      }
      await this.sleep(this.config.t3.pollIntervalMs);
    }
  }
  changed(project: string, files: string[]) {
    // Source attribution is heuristic: the newest active/recently completed request owns changes.
    const r = [...this.requests.values()]
      .reverse()
      .find(
        (r) =>
          r.project.id === project &&
          (r.eligible || (r.completedAt !== undefined && this.now() - r.completedAt <= 120000)),
      );
    if (!r) return;
    const changedFiles = [...new Set(files)].slice(0, 50);
    r.sourceChanged = true;
    this.emit(r, "source_changed", undefined, changedFiles);
    const native = changedFiles.filter(isNativeChange);
    if (native.length)
      this.emit(
        r,
        "native_rebuild_required",
        `${native.join(", ")} may need \`npx expo prebuild\` / a new development build`,
        native,
      );
    const pending = this.pendingRefresh.get(project);
    this.pendingRefresh.delete(project);
    if (pending && this.now() - pending.at <= 5000)
      this.emit(r, pending.kind === "error" ? "refresh_failed" : "refresh_observed", pending.message);
  }
  refresh(project: string, kind: "applied" | "full-reload" | "error", message?: string) {
    const r = [...this.requests.values()].reverse().find((r) => r.project.id === project);
    if (r?.sourceChanged)
      this.emit(r, kind === "error" ? "refresh_failed" : "refresh_observed", message);
    else if (r) this.pendingRefresh.set(project, { kind, ...(message ? { message } : {}), at: this.now() });
  }
  stop() {
    this.stopped = true;
    for (const watcher of this.watchers.values()) watcher.close();
    for (const [timer, resolve] of this.sleepers) {
      clearTimeout(timer);
      resolve();
    }
    this.sleepers.clear();
  }
}
