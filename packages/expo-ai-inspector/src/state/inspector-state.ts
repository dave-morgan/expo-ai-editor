import type {
  DeliveryMode,
  RequestPhase,
  Selection,
  ServerMessage,
} from "@dave-morgan/expo-ai-protocol";

export interface TrackedRequest {
  requestId: string;
  instruction: string;
  componentName?: string;
  sourceLabel?: string;
  threadId?: string;
  /** Latest phase received. */
  phase: RequestPhase | "sending";
  /** Every phase seen, with the time it was first reported. Phases can interleave: the agent
   * may still be working while files change and Fast Refresh applies. */
  seen: Partial<Record<RequestPhase | "sending", number>>;
  detail?: string;
  changedFiles?: string[];
  createdAt: number;
  updatedAt: number;
  /** Kept for retry. */
  payload: {
    instruction: string;
    selection?: Selection;
    inputMethod: "voice" | "typed" | "voice-edited";
  };
}

export interface InspectorSettings {
  screenshots: boolean;
  autoSubmit: boolean;
  mode: DeliveryMode;
}

export interface InspectorState {
  selectionEnabled: boolean;
  panelOpen: boolean;
  selection: Selection | null;
  selecting: boolean;
  transcript: string;
  inputMethod: "voice" | "typed" | "voice-edited";
  activeRequestId: string | null;
  requests: Record<string, TrackedRequest>;
  history: string[];
  settings: InspectorSettings;
  error: string | null;
  view: "main" | "threads" | "history" | "settings" | "pair";
}

export const MAX_HISTORY = 20;

export function createInitialState(settings: Partial<InspectorSettings> = {}): InspectorState {
  return {
    selectionEnabled: false,
    panelOpen: false,
    selection: null,
    selecting: false,
    transcript: "",
    inputMethod: "typed",
    activeRequestId: null,
    requests: {},
    history: [],
    settings: { screenshots: true, autoSubmit: false, mode: "queue", ...settings },
    error: null,
    view: "main",
  };
}

export type InspectorAction =
  | { type: "open" }
  | { type: "close" }
  | { type: "toggleSelection" }
  | { type: "startSelecting" }
  | { type: "hitTestStarted" }
  | { type: "selected"; selection: Selection }
  | { type: "selectionFailed"; message: string }
  | { type: "clearSelection" }
  | { type: "setTranscript"; text: string; edited: boolean }
  | { type: "appendVoice"; text: string }
  | { type: "submitted"; request: Omit<TrackedRequest, "phase" | "seen" | "updatedAt"> }
  | { type: "server"; message: ServerMessage; now: number }
  | { type: "cancelLocal"; requestId: string }
  | {
      type: "setSetting";
      key: keyof InspectorSettings;
      value: InspectorSettings[keyof InspectorSettings];
    }
  | { type: "setView"; view: InspectorState["view"] }
  | { type: "error"; message: string | null }
  | { type: "dismissRequest" };

const TERMINAL: ReadonlySet<TrackedRequest["phase"]> = new Set([
  "agent_failed",
  "refresh_observed",
  "refresh_failed",
  "native_rebuild_required",
  "cancelled",
  "failed",
]);

export function isTerminalPhase(phase: TrackedRequest["phase"]): boolean {
  return TERMINAL.has(phase);
}

export function canRetry(request: TrackedRequest): boolean {
  return (
    request.phase === "failed" || request.phase === "agent_failed" || request.phase === "cancelled"
  );
}

export function canCancel(request: TrackedRequest): boolean {
  return request.phase === "sending" || request.phase === "received" || request.phase === "queued";
}

export function inspectorReducer(state: InspectorState, action: InspectorAction): InspectorState {
  switch (action.type) {
    case "open":
      return { ...state, panelOpen: true };
    case "close":
      return { ...state, panelOpen: false, view: "main" };
    case "toggleSelection":
      return {
        ...state,
        selectionEnabled: !state.selectionEnabled,
        panelOpen: false,
        selecting: false,
        error: null,
        view: "main",
      };
    case "startSelecting":
      return {
        ...state,
        selectionEnabled: true,
        panelOpen: false,
        selecting: false,
        error: null,
        view: "main",
      };
    case "hitTestStarted":
      return state.selectionEnabled ? { ...state, selecting: true } : state;
    case "selected":
      return state.selectionEnabled
        ? { ...state, selecting: false, selection: action.selection, error: null, view: "main" }
        : state;
    case "selectionFailed":
      return state.selectionEnabled
        ? { ...state, panelOpen: true, view: "main", selecting: false, error: action.message }
        : state;
    case "clearSelection":
      return { ...state, selection: null, selectionEnabled: true, panelOpen: false };
    case "setTranscript": {
      if (!action.edited) return { ...state, transcript: action.text };
      // Keyboard edits to a dictated transcript are recorded as "voice-edited".
      const dictated = state.inputMethod !== "typed" && state.transcript.trim().length > 0;
      return {
        ...state,
        transcript: action.text,
        inputMethod: dictated ? "voice-edited" : "typed",
      };
    }
    case "appendVoice": {
      const text = state.transcript.trim()
        ? `${state.transcript.trim()} ${action.text}`
        : action.text;
      return {
        ...state,
        transcript: text,
        inputMethod:
          state.inputMethod === "typed" && state.transcript.trim() ? "voice-edited" : "voice",
      };
    }
    case "submitted": {
      const request: TrackedRequest = {
        ...action.request,
        phase: "sending",
        seen: { sending: action.request.createdAt },
        updatedAt: action.request.createdAt,
      };
      const history = [
        request.requestId,
        ...state.history.filter((id) => id !== request.requestId),
      ].slice(0, MAX_HISTORY);
      const requests: Record<string, TrackedRequest> = {};
      for (const id of history) {
        const existing = id === request.requestId ? request : state.requests[id];
        if (existing) requests[id] = existing;
      }
      return {
        ...state,
        requests,
        history,
        activeRequestId: request.requestId,
        transcript: "",
        inputMethod: "typed",
        error: null,
      };
    }
    case "server":
      return applyServerMessage(state, action.message, action.now);
    case "cancelLocal": {
      const request = state.requests[action.requestId];
      if (!request || !canCancel(request)) return state;
      return update(state, withPhase(request, "cancelled", Date.now(), "Cancelled"));
    }
    case "setSetting":
      return { ...state, settings: { ...state.settings, [action.key]: action.value } };
    case "setView":
      return { ...state, view: action.view };
    case "error":
      return { ...state, error: action.message };
    case "dismissRequest":
      return { ...state, activeRequestId: null };
    default:
      return state;
  }
}

function applyServerMessage(
  state: InspectorState,
  message: ServerMessage,
  now: number,
): InspectorState {
  if (message.type === "feedback.ack") {
    const request = state.requests[message.requestId];
    if (!request) return state;
    if (message.result === "rejected") {
      return update(
        state,
        withPhase(request, "failed", now, message.reason ?? "Rejected by bridge"),
      );
    }
    if (message.result === "duplicate" && request.phase === "sending") {
      return update(
        state,
        withPhase(request, "received", now, message.reason ?? "Already received"),
      );
    }
    return state;
  }
  if (message.type === "request.status") {
    const request = state.requests[message.requestId];
    if (!request) return state;
    // A cancelled/failed request stays that way; a replayed older status must not regress it.
    if (
      (request.phase === "cancelled" || request.phase === "failed") &&
      message.phase !== request.phase
    )
      return state;
    const next = withPhase(request, message.phase, now, message.detail);
    if (message.changedFiles)
      next.changedFiles = [...new Set([...(request.changedFiles ?? []), ...message.changedFiles])];
    if (message.threadId) next.threadId = message.threadId;
    return update(state, next);
  }
  if (message.type === "error" && !message.fatal) {
    return { ...state, error: message.message };
  }
  return state;
}

function withPhase(
  request: TrackedRequest,
  phase: TrackedRequest["phase"],
  now: number,
  detail?: string,
): TrackedRequest {
  return {
    ...request,
    phase,
    seen: { ...request.seen, [phase]: request.seen[phase] ?? now },
    ...(detail !== undefined ? { detail } : {}),
    updatedAt: now,
  };
}

export type AgentStep = "pending" | "working" | "waiting" | "completed" | "failed";

/** Agent progress derived from every phase seen (not just the latest). */
export function agentStep(request: TrackedRequest): AgentStep {
  const seen = request.seen;
  if (seen.agent_failed) return "failed";
  if (seen.agent_completed) return "completed";
  if (request.phase === "agent_waiting") return "waiting";
  if (seen.agent_working || seen.agent_waiting) return "working";
  return "pending";
}

export function refreshStep(
  request: TrackedRequest,
): "none" | "source_changed" | "observed" | "failed" | "native" {
  const seen = request.seen;
  if (seen.native_rebuild_required) return "native";
  if (
    seen.refresh_failed &&
    (!seen.refresh_observed || seen.refresh_failed > seen.refresh_observed)
  )
    return "failed";
  if (seen.refresh_observed) return "observed";
  if (seen.source_changed) return "source_changed";
  return "none";
}

function update(state: InspectorState, request: TrackedRequest): InspectorState {
  return { ...state, requests: { ...state.requests, [request.requestId]: request } };
}

export const PHASE_LABELS: Record<TrackedRequest["phase"], string> = {
  sending: "Sending…",
  received: "Received by bridge",
  queued: "Queued",
  submitted: "Delivered to T3 thread",
  agent_working: "Agent working",
  agent_waiting: "Agent needs your input in T3",
  agent_completed: "Agent finished",
  agent_failed: "Agent run failed",
  source_changed: "Source changed — waiting for refresh",
  refresh_observed: "Refreshed on device",
  refresh_failed: "Refresh failed",
  native_rebuild_required: "Native rebuild required",
  cancelled: "Cancelled",
  failed: "Failed",
};

export type StageState = "done" | "active" | "waiting" | "failed" | "pending";

export interface LifecycleStage {
  key: "sent" | "delivered" | "agent" | "files" | "refresh";
  label: string;
  state: StageState;
  /** When the stage was first reached (epoch ms), if it has been. */
  at?: number;
}

/**
 * The five user-facing steps of one request, in order, for the panel's lifecycle rail.
 * Phases can interleave (files change while the agent is still working), so each step reads
 * its own evidence from `seen` rather than from the latest phase alone.
 */
export function requestLifecycle(request: TrackedRequest): LifecycleStage[] {
  const { seen, phase } = request;
  const stopped = phase === "failed" || phase === "cancelled";
  const deliveredAt = seen.submitted ?? seen.agent_working ?? seen.agent_waiting ?? seen.agent_completed;
  const agent = agentStep(request);
  const refresh = refreshStep(request);
  const files = request.changedFiles?.length ?? 0;
  const firstPending = (state: StageState) => (stopped ? "pending" : state);

  const sent: LifecycleStage = {
    key: "sent",
    label: phase === "sending" ? "Sending" : "Sent",
    state: phase === "sending" ? "active" : "done",
    at: seen.sending ?? request.createdAt,
  };
  const delivered: LifecycleStage = deliveredAt
    ? { key: "delivered", label: "Delivered", state: "done", at: deliveredAt }
    : stopped
      ? { key: "delivered", label: phase === "cancelled" ? "Cancelled" : "Not delivered", state: "failed", at: seen[phase] }
      : seen.queued
        ? { key: "delivered", label: "Queued", state: "waiting", at: seen.queued }
        : { key: "delivered", label: "Delivery", state: phase === "sending" ? "pending" : "active" };
  const agentStage: LifecycleStage =
    agent === "completed"
      ? { key: "agent", label: "Agent done", state: "done", at: seen.agent_completed }
      : agent === "failed"
        ? { key: "agent", label: "Agent failed", state: "failed", at: seen.agent_failed }
        : agent === "waiting"
          ? { key: "agent", label: "Needs input in T3", state: "waiting", at: seen.agent_waiting }
          : agent === "working"
            ? { key: "agent", label: "Agent working", state: "active", at: seen.agent_working }
            : { key: "agent", label: "Agent", state: "pending" };
  const filesStage: LifecycleStage =
    refresh !== "none"
      ? { key: "files", label: files === 1 ? "1 file changed" : files > 1 ? `${files} files changed` : "Files changed", state: "done", at: seen.source_changed }
      : { key: "files", label: "Files", state: firstPending(agent === "completed" ? "active" : "pending") };
  const refreshStage: LifecycleStage =
    refresh === "observed"
      ? { key: "refresh", label: "Refreshed", state: "done", at: seen.refresh_observed }
      : refresh === "failed"
        ? { key: "refresh", label: "Refresh failed", state: "failed", at: seen.refresh_failed }
        : refresh === "native"
          ? { key: "refresh", label: "Rebuild needed", state: "waiting", at: seen.native_rebuild_required }
          : { key: "refresh", label: "Refresh", state: firstPending(refresh === "source_changed" ? "active" : "pending") };
  return [sent, delivered, agentStage, filesStage, refreshStage];
}

/** Compact elapsed time for the rail: `+0.8s`, `+12s`, `+3m 05s`. */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 10_000) return `+${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `+${seconds}s`;
  return `+${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** Overall outcome of a request, for one-line rows of earlier requests. */
export function requestOutcome(request: TrackedRequest): StageState {
  if (request.phase === "failed" || request.phase === "cancelled" || request.phase === "agent_failed" || request.phase === "refresh_failed")
    return "failed";
  if (request.phase === "agent_waiting" || request.phase === "native_rebuild_required" || request.phase === "queued") return "waiting";
  if (request.phase === "refresh_observed" || request.phase === "agent_completed") return "done";
  return "active";
}
