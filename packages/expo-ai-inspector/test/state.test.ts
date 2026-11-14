import type { Selection } from "@dave-morgan/expo-ai-protocol";
import { describe, expect, it } from "vitest";
import {
  agentStep,
  canCancel,
  canRetry,
  createInitialState,
  inspectorReducer,
  refreshStep,
  type InspectorAction,
  type InspectorState,
} from "../src/state/inspector-state";

const selection: Selection = {
  elementType: "Text",
  componentName: "ProfileHeader",
  source: { file: "src/components/ProfileHeader.tsx", line: 42, column: 6 },
  sourceOrigin: "babel-transform",
  confidence: "high",
  confidenceNotes: [],
  hierarchy: [],
  bounds: { x: 0, y: 0, width: 10, height: 10 },
};

const run = (state: InspectorState, ...actions: InspectorAction[]) => actions.reduce(inspectorReducer, state);
const status = (requestId: string, phase: string, extra: object = {}): InspectorAction => ({
  type: "server",
  now: Date.now(),
  message: { type: "request.status", requestId, phase: phase as never, at: new Date().toISOString(), ...extra },
});
const submit = (requestId = "req_00000001"): InspectorAction => ({
  type: "submitted",
  request: { requestId, instruction: "Make it smaller", createdAt: 1, payload: { instruction: "Make it smaller", inputMethod: "typed" } },
});

describe("inspector state", () => {
  it("is closed by default and enters selection mode when opened without a selection", () => {
    const state = createInitialState();
    expect(state.mode).toBe("closed");
    expect(run(state, { type: "open" }).mode).toBe("selecting");
  });

  it("goes from selecting to panel on selection and back on reselect/clear", () => {
    let state = run(createInitialState(), { type: "startSelecting" }, { type: "hitTestStarted" });
    expect(state.selecting).toBe(true);
    state = run(state, { type: "selected", selection });
    expect(state).toMatchObject({ mode: "panel", selecting: false, selection });
    expect(run(state, { type: "open" }).mode).toBe("panel");
    expect(run(state, { type: "clearSelection" })).toMatchObject({ mode: "selecting", selection: null });
    expect(run(state, { type: "close" }).mode).toBe("closed");
  });

  it("records selection failures without leaving selection mode", () => {
    const state = run(createInitialState(), { type: "startSelecting" }, { type: "selectionFailed", message: "Nothing there" });
    expect(state).toMatchObject({ mode: "selecting", error: "Nothing there", selecting: false });
  });

  it("tracks the transcript input method (typed, voice, voice-edited)", () => {
    let state = run(createInitialState(), { type: "setTranscript", text: "make it red", edited: true });
    expect(state.inputMethod).toBe("typed");
    state = run(createInitialState(), { type: "appendVoice", text: "Make this heading smaller" });
    expect(state).toMatchObject({ transcript: "Make this heading smaller", inputMethod: "voice" });
    state = run(state, { type: "appendVoice", text: "and bold" });
    expect(state.transcript).toBe("Make this heading smaller and bold");
    state = run(state, { type: "setTranscript", text: "Make this heading 20% smaller and bold", edited: true });
    expect(state.inputMethod).toBe("voice-edited");
  });

  it("tracks request phases, including interleaved agent and refresh events", () => {
    let state = run(createInitialState(), { type: "setTranscript", text: "x", edited: true }, submit());
    expect(state.transcript).toBe("");
    expect(state.activeRequestId).toBe("req_00000001");
    state = run(
      state,
      { type: "server", now: 2, message: { type: "feedback.ack", requestId: "req_00000001", result: "accepted" } },
      status("req_00000001", "submitted"),
      status("req_00000001", "agent_working"),
      status("req_00000001", "source_changed", { changedFiles: ["src/a.tsx"] }),
      status("req_00000001", "refresh_observed"),
    );
    let request = state.requests.req_00000001!;
    expect(agentStep(request)).toBe("working");
    expect(refreshStep(request)).toBe("observed");
    state = run(state, status("req_00000001", "source_changed", { changedFiles: ["src/b.tsx"] }), status("req_00000001", "agent_completed"));
    request = state.requests.req_00000001!;
    expect(agentStep(request)).toBe("completed");
    expect(request.changedFiles).toEqual(["src/a.tsx", "src/b.tsx"]);
  });

  it("marks rejected requests failed and allows retry, but not cancel", () => {
    const state = run(createInitialState(), submit(), {
      type: "server",
      now: 2,
      message: { type: "feedback.ack", requestId: "req_00000001", result: "rejected", reason: "no thread" },
    });
    const request = state.requests.req_00000001!;
    expect(request.phase).toBe("failed");
    expect(canRetry(request)).toBe(true);
    expect(canCancel(request)).toBe(false);
  });

  it("only cancels requests that have not been delivered", () => {
    let state = run(createInitialState(), submit(), status("req_00000001", "queued"));
    expect(canCancel(state.requests.req_00000001!)).toBe(true);
    state = run(state, { type: "cancelLocal", requestId: "req_00000001" }, status("req_00000001", "submitted"));
    expect(state.requests.req_00000001!.phase).toBe("cancelled");
    const delivered = run(createInitialState(), submit(), status("req_00000001", "submitted"), { type: "cancelLocal", requestId: "req_00000001" });
    expect(delivered.requests.req_00000001!.phase).toBe("submitted");
  });

  it("caps history and ignores statuses for unknown requests", () => {
    let state = createInitialState();
    for (let i = 0; i < 25; i += 1) state = run(state, submit(`req_${String(i).padStart(8, "0")}`));
    expect(state.history).toHaveLength(20);
    expect(Object.keys(state.requests)).toHaveLength(20);
    expect(run(state, status("req_unknown1", "agent_working"))).toBe(state);
  });

  it("reports native rebuilds and refresh failures", () => {
    const state = run(createInitialState(), submit(), status("req_00000001", "source_changed"), status("req_00000001", "native_rebuild_required"));
    expect(refreshStep(state.requests.req_00000001!)).toBe("native");
    const failed = run(createInitialState(), submit(), status("req_00000001", "source_changed"), status("req_00000001", "refresh_failed"));
    expect(refreshStep(failed.requests.req_00000001!)).toBe("failed");
  });

  it("surfaces non-fatal bridge errors and settings changes", () => {
    let state = run(createInitialState({ screenshots: false }), {
      type: "server",
      now: 1,
      message: { type: "error", code: "no_thread_selected", message: "Choose a thread", fatal: false },
    });
    expect(state.error).toBe("Choose a thread");
    expect(state.settings.screenshots).toBe(false);
    state = run(state, { type: "setSetting", key: "autoSubmit", value: true }, { type: "setSetting", key: "mode", value: "auto" });
    expect(state.settings).toMatchObject({ autoSubmit: true, mode: "auto" });
  });
});
