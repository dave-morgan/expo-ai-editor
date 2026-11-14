import { describe, expect, it } from "vitest";
import { formatElapsed, requestLifecycle, requestOutcome, type TrackedRequest } from "../src/state/inspector-state";

const T0 = 1_000_000;
function request(phase: TrackedRequest["phase"], seen: TrackedRequest["seen"], extra: Partial<TrackedRequest> = {}): TrackedRequest {
  return {
    requestId: "r1",
    instruction: "Make the title bigger",
    phase,
    seen,
    createdAt: T0,
    updatedAt: T0,
    payload: { instruction: "Make the title bigger", inputMethod: "typed" },
    ...extra,
  };
}
const states = (r: TrackedRequest) => requestLifecycle(r).map((s) => `${s.key}:${s.state}`);

describe("request lifecycle rail", () => {
  it("shows sending as the only active step", () => {
    expect(states(request("sending", { sending: T0 }))).toEqual([
      "sent:active",
      "delivered:pending",
      "agent:pending",
      "files:pending",
      "refresh:pending",
    ]);
  });
  it("marks queued delivery as waiting", () => {
    const stages = requestLifecycle(request("queued", { sending: T0, received: T0 + 50, queued: T0 + 80 }));
    expect(stages[1]).toMatchObject({ label: "Queued", state: "waiting", at: T0 + 80 });
  });
  it("follows a full successful run with timestamps", () => {
    const r = request(
      "refresh_observed",
      { sending: T0, submitted: T0 + 400, agent_working: T0 + 900, source_changed: T0 + 7000, agent_completed: T0 + 9000, refresh_observed: T0 + 7600 },
      { changedFiles: ["app/index.tsx", "src/ui/Card.tsx"] },
    );
    expect(states(r)).toEqual(["sent:done", "delivered:done", "agent:done", "files:done", "refresh:done"]);
    expect(requestLifecycle(r)[3]?.label).toBe("2 files changed");
    expect(requestOutcome(r)).toBe("done");
  });
  it("shows files and refresh while the agent is still working", () => {
    const r = request("source_changed", { sending: T0, submitted: T0 + 1, agent_working: T0 + 2, source_changed: T0 + 3 });
    expect(states(r)).toEqual(["sent:done", "delivered:done", "agent:active", "files:done", "refresh:active"]);
  });
  it("flags input needed, rebuilds and failures", () => {
    expect(requestLifecycle(request("agent_waiting", { submitted: T0, agent_waiting: T0 + 5 }))[2]).toMatchObject({ state: "waiting", label: "Needs input in T3" });
    expect(requestLifecycle(request("native_rebuild_required", { submitted: T0, source_changed: T0 + 1, native_rebuild_required: T0 + 2 }))[4]).toMatchObject({ state: "waiting", label: "Rebuild needed" });
    const failed = request("failed", { sending: T0, failed: T0 + 30 });
    expect(states(failed)).toEqual(["sent:done", "delivered:failed", "agent:pending", "files:pending", "refresh:pending"]);
    expect(requestOutcome(failed)).toBe("failed");
    expect(requestLifecycle(request("cancelled", { cancelled: T0 + 3 }))[1]?.label).toBe("Cancelled");
  });
});

describe("formatElapsed", () => {
  it("formats compact offsets", () => {
    expect(formatElapsed(800)).toBe("+0.8s");
    expect(formatElapsed(12_400)).toBe("+12s");
    expect(formatElapsed(185_000)).toBe("+3m 05s");
    expect(formatElapsed(-1)).toBe("");
  });
});
