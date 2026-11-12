import { describe, expect, it } from "vitest";

import type { AgentThreadState } from "../src/agent-adapter.js";
import { classifyRun } from "../src/run-classifier.js";

const run = (ordinal: number) => `run:thread:mcp%3A42:ordinal:${ordinal}`;
const state = (changes: Partial<AgentThreadState> = {}): AgentThreadState => ({
  threadId: "mcp:42",
  title: "Test",
  status: "running",
  activeRunId: null,
  latestRunId: run(2),
  pendingRequestCount: 0,
  ...changes,
});

describe("classifyRun", () => {
  it("returns unknown without a run id", () => expect(classifyRun(state(), null)).toBe("unknown"));
  it.each([
    [1, "queued"],
    [2, "working"],
    [3, "completed"],
  ] as const)("classifies active ordinal %s", (ordinal, phase) => {
    expect(classifyRun(state({ activeRunId: run(ordinal) }), run(2))).toBe(phase);
  });
  it.each([{ pendingRequestCount: 1 }, { status: "waiting" }])(
    "recognizes an active run waiting for input: %o",
    (changes) => {
      expect(classifyRun(state({ activeRunId: run(2), ...changes }), run(2))).toBe("waiting");
    },
  );
  it("does not confuse an older run waiting for input with ours", () => {
    expect(
      classifyRun(
        state({ activeRunId: run(1), pendingRequestCount: 1, status: "waiting" }),
        run(2),
      ),
    ).toBe("queued");
  });
  it.each(["completed", "idle"])("recognizes settled %s", (status) => {
    expect(classifyRun(state({ status }), run(2))).toBe("completed");
    expect(classifyRun(state({ status, latestRunId: run(3) }), run(2))).toBe("completed");
  });
  it.each(["failed", "interrupted", "cancelled", "error"])(
    "recognizes terminal %s only for our latest run",
    (status) => {
      expect(classifyRun(state({ status }), run(2))).toBe("failed");
      expect(classifyRun(state({ status, latestRunId: run(3) }), run(2))).toBe("unknown");
    },
  );
  it("returns queued when the latest run is older", () => {
    expect(classifyRun(state({ latestRunId: run(1), status: "completed" }), run(2))).toBe("queued");
  });
  it.each([{ status: "waiting" }, { pendingRequestCount: 1 }])(
    "recognizes a latest run waiting without an active run: %o",
    (changes) => {
      expect(classifyRun(state(changes), run(2))).toBe("waiting");
    },
  );
  it.each([null, "bad", "run:thread:x:ordinal:2:extra"])(
    "handles malformed latest ids: %s",
    (latestRunId) => {
      expect(classifyRun(state({ latestRunId, status: "completed" }), run(2))).toBe("unknown");
    },
  );
  it("handles malformed target and active ids conservatively", () => {
    expect(classifyRun(state(), "bad")).toBe("unknown");
    expect(classifyRun(state({ activeRunId: "bad" }), run(2))).toBe("unknown");
  });
  it("uses trailing ordinals with exact integer precision", () => {
    expect(
      classifyRun(
        state({ activeRunId: "run:thread:x:ordinal:9007199254740993" }),
        "run:thread:x:ordinal:9007199254740992",
      ),
    ).toBe("completed");
  });
});
