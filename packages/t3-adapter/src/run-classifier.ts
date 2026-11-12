import type { AgentThreadState, RunPhase } from "./agent-adapter.js";

function ordinal(runId: string | null): bigint | null {
  const value = runId?.match(/:ordinal:(\d+)$/)?.[1];
  return value === undefined ? null : BigInt(value);
}

export function classifyRun(state: AgentThreadState, runId: string | null): RunPhase {
  const ours = ordinal(runId);
  if (ours === null) return "unknown";
  if (state.activeRunId !== null) {
    const active = ordinal(state.activeRunId);
    if (active === null) return "unknown";
    if (active < ours) return "queued";
    if (active > ours) return "completed";
    return state.pendingRequestCount > 0 || state.status === "waiting" ? "waiting" : "working";
  }
  const latest = ordinal(state.latestRunId);
  if (latest === null) return "unknown";
  if (latest < ours) return "queued";
  if (latest === ours && (state.pendingRequestCount > 0 || state.status === "waiting"))
    return "waiting";
  if (state.status === "completed" || state.status === "idle") return "completed";
  if (latest === ours && ["failed", "interrupted", "cancelled", "error"].includes(state.status))
    return "failed";
  return "unknown";
}
