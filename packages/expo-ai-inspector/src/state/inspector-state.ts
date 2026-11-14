import type { DeliveryMode, RequestPhase, Selection, ServerMessage } from "@dave-morgan/expo-ai-protocol";

export type InspectorMode = "closed" | "selecting" | "panel";

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
  payload: { instruction: string; selection?: Selection; inputMethod: "voice" | "typed" | "voice-edited" };
}

export interface InspectorSettings {
  screenshots: boolean;
  autoSubmit: boolean;
  mode: DeliveryMode;
}

export interface InspectorState {
  mode: InspectorMode;
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
    mode: "closed",
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
  | { type: "setSetting"; key: keyof InspectorSettings; value: InspectorSettings[keyof InspectorSettings] }
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
  return request.phase === "failed" || request.phase === "agent_failed" || request.phase === "cancelled";
}

export function canCancel(request: TrackedRequest): boolean {
  return request.phase === "sending" || request.phase === "received" || request.phase === "queued";
}

export function inspectorReducer(state: InspectorState, action: InspectorAction): InspectorState {
  switch (action.type) {
    case "open":
      return { ...state, mode: state.selection ? "panel" : "selecting", error: null };
    case "close":
      return { ...state, mode: "closed", selecting: false, view: "main" };
    case "startSelecting":
      return { ...state, mode: "selecting", selecting: false, error: null, view: "main" };
    case "hitTestStarted":
      return { ...state, selecting: true };
    case "selected":
      return { ...state, mode: "panel", selecting: false, selection: action.selection, error: null, view: "main" };
    case "selectionFailed":
      return { ...state, selecting: false, error: action.message };
    case "clearSelection":
      return { ...state, selection: null, mode: "selecting" };
    case "setTranscript": {
      if (!action.edited) return { ...state, transcript: action.text };
      // Keyboard edits to a dictated transcript are recorded as "voice-edited".
      const dictated = state.inputMethod !== "typed" && state.transcript.trim().length > 0;
      return { ...state, transcript: action.text, inputMethod: dictated ? "voice-edited" : "typed" };
    }
    case "appendVoice": {
      const text = state.transcript.trim() ? `${state.transcript.trim()} ${action.text}` : action.text;
      return { ...state, transcript: text, inputMethod: state.inputMethod === "typed" && state.transcript.trim() ? "voice-edited" : "voice" };
    }
    case "submitted": {
      const request: TrackedRequest = {
        ...action.request,
        phase: "sending",
        seen: { sending: action.request.createdAt },
        updatedAt: action.request.createdAt,
      };
      const history = [request.requestId, ...state.history.filter((id) => id !== request.requestId)].slice(0, MAX_HISTORY);
      const requests: Record<string, TrackedRequest> = {};
      for (const id of history) {
        const existing = id === request.requestId ? request : state.requests[id];
        if (existing) requests[id] = existing;
      }
      return { ...state, requests, history, activeRequestId: request.requestId, transcript: "", inputMethod: "typed", error: null };
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

function applyServerMessage(state: InspectorState, message: ServerMessage, now: number): InspectorState {
  if (message.type === "feedback.ack") {
    const request = state.requests[message.requestId];
    if (!request) return state;
    if (message.result === "rejected") {
      return update(state, withPhase(request, "failed", now, message.reason ?? "Rejected by bridge"));
    }
    if (message.result === "duplicate" && request.phase === "sending") {
      return update(state, withPhase(request, "received", now, message.reason ?? "Already received"));
    }
    return state;
  }
  if (message.type === "request.status") {
    const request = state.requests[message.requestId];
    if (!request) return state;
    // A cancelled/failed request stays that way; a replayed older status must not regress it.
    if ((request.phase === "cancelled" || request.phase === "failed") && message.phase !== request.phase) return state;
    const next = withPhase(request, message.phase, now, message.detail);
    if (message.changedFiles) next.changedFiles = [...new Set([...(request.changedFiles ?? []), ...message.changedFiles])];
    if (message.threadId) next.threadId = message.threadId;
    return update(state, next);
  }
  if (message.type === "error" && !message.fatal) {
    return { ...state, error: message.message };
  }
  return state;
}

function withPhase(request: TrackedRequest, phase: TrackedRequest["phase"], now: number, detail?: string): TrackedRequest {
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

export function refreshStep(request: TrackedRequest): "none" | "source_changed" | "observed" | "failed" | "native" {
  const seen = request.seen;
  if (seen.native_rebuild_required) return "native";
  if (seen.refresh_failed && (!seen.refresh_observed || seen.refresh_failed > seen.refresh_observed)) return "failed";
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
