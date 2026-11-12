import { describe, expect, it } from "vitest";
import {
  createRequestId,
  decodeClientMessage,
  decodeServerMessage,
  encodeClientMessage,
  FeedbackSchema,
  LIMITS,
  PROTOCOL_VERSION,
} from "../src/index.js";

const feedback = {
  requestId: "req_12345678",
  projectId: "example-expo",
  instruction: "Make this heading 20% smaller",
  inputMethod: "voice" as const,
  createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
  selection: {
    elementType: "Text",
    componentName: "ProfileHeader",
    source: { file: "src/components/ProfileHeader.tsx", line: 42, column: 6 },
    sourceOrigin: "babel-transform" as const,
    confidence: "high" as const,
    bounds: { x: 24, y: 120, width: 280, height: 40 },
    visibleText: "Welcome back",
  },
};

describe("protocol", () => {
  it("round-trips a feedback submission", () => {
    const frame = encodeClientMessage({ type: "feedback.submit", feedback });
    const decoded = decodeClientMessage(frame);
    expect(decoded.ok).toBe(true);
    if (decoded.ok && decoded.value.type === "feedback.submit") {
      expect(decoded.value.feedback.mode).toBe("queue");
      expect(decoded.value.feedback.selection?.hierarchy).toEqual([]);
    }
  });

  it("rejects unknown message types and bad JSON", () => {
    expect(decodeClientMessage('{"type":"exec","cmd":"rm -rf /"}').ok).toBe(false);
    expect(decodeClientMessage("{not json").ok).toBe(false);
  });

  it("rejects path-like or shell-like ids", () => {
    const bad = { ...feedback, threadId: "../../etc; rm -rf" };
    expect(FeedbackSchema.safeParse(bad).success).toBe(false);
    expect(FeedbackSchema.safeParse({ ...feedback, projectId: "-flag" }).success).toBe(false);
  });

  it("enforces instruction and screenshot limits", () => {
    expect(FeedbackSchema.safeParse({ ...feedback, instruction: "   " }).success).toBe(false);
    expect(
      FeedbackSchema.safeParse({ ...feedback, instruction: "x".repeat(LIMITS.maxInstructionChars + 1) })
        .success,
    ).toBe(false);
    const screenshot = {
      mimeType: "image/jpeg",
      base64: "a".repeat(LIMITS.maxScreenshotBase64Chars + 1),
      width: 10,
      height: 10,
    };
    expect(FeedbackSchema.safeParse({ ...feedback, screenshot }).success).toBe(false);
  });

  it("validates server frames", () => {
    const ok = decodeServerMessage({
      type: "request.status",
      requestId: "req_12345678",
      phase: "agent_working",
      at: new Date().toISOString(),
    });
    expect(ok.ok).toBe(true);
    expect(decodeServerMessage({ type: "request.status", requestId: "x", phase: "done" }).ok).toBe(false);
  });

  it("creates unique url-safe request ids", () => {
    const ids = new Set(Array.from({ length: 200 }, () => createRequestId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
