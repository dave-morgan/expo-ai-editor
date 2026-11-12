import { afterEach, expect, it, vi } from "vitest";
import { FeedbackSchema } from "@expo-ai/protocol";
import { AdapterUnavailableError } from "@expo-ai/t3-adapter";
import type { AgentAdapter } from "@expo-ai/t3-adapter";
import { FeedbackPipeline } from "../src/pipeline.js";
import { loadConfig } from "../src/config.js";

afterEach(() => vi.useRealTimers());
async function setup(
  send = vi.fn(async (_input: Parameters<AgentAdapter["sendMessage"]>[0]) => ({
    runId: null,
    delivery: "queued" as const,
  })),
) {
  const config = await loadConfig({
    flags: { projectId: "app", projectRoot: process.cwd(), t3Project: "app" },
  });
  const adapter: AgentAdapter = {
    id: "test",
    capabilities: () => ({
      adapter: "test",
      queue: true,
      steer: false,
      attachments: false,
      listThreads: true,
      runStatus: true,
    }),
    diagnose: async () => ({ ok: true, checks: [] }),
    listThreads: async () => [],
    getThread: async () => ({
      threadId: "thread",
      title: "x",
      status: "completed",
      activeRunId: null,
      latestRunId: null,
      pendingRequestCount: 0,
    }),
    sendMessage: send,
    classifyRun: () => "completed",
  };
  const statuses: { requestId: string; phase: string; detail?: string }[] = [];
  const pipeline = new FeedbackPipeline(
    config,
    adapter,
    (_project, status) => statuses.push(status),
    () => Date.now(),
    () => ({ close() {} }),
  );
  const feedback = (id: string, instruction = id) =>
    FeedbackSchema.parse({
      requestId: id,
      projectId: "app",
      instruction,
      inputMethod: "typed",
      createdAt: new Date().toISOString(),
    });
  return { pipeline, send, statuses, feedback, adapter, config };
}

it("attributes changes and refresh to the latest request even within one millisecond", async () => {
  const { pipeline, feedback, statuses } = await setup();
  vi.useFakeTimers();
  pipeline.submit(feedback("request_1"), "client", "thread");
  pipeline.submit(feedback("request_2"), "client", "thread");
  await vi.advanceTimersByTimeAsync(1);
  pipeline.refresh("app", "applied");
  expect(statuses.at(-1)?.phase).toBe("agent_completed");
  pipeline.changed("app", ["app.json"]);
  expect(statuses.at(-1)).toMatchObject({
    requestId: "request_2",
    phase: "native_rebuild_required",
  });
  pipeline.refresh("app", "error", "Refresh failed");
  expect(statuses.at(-1)).toMatchObject({
    requestId: "request_2",
    phase: "refresh_failed",
    detail: "Refresh failed",
  });
  pipeline.stop();
});

it("emits run phase changes once and expires statuses after thirty minutes", async () => {
  const { pipeline, feedback, statuses, adapter } = await setup();
  vi.useFakeTimers();
  let phase: ReturnType<AgentAdapter["classifyRun"]> = "working";
  adapter.classifyRun = () => phase;
  pipeline.submit(feedback("request_1"), "client", "thread");
  await vi.advanceTimersByTimeAsync(4001);
  expect(statuses.filter((s) => s.phase === "agent_working")).toHaveLength(1);
  phase = "waiting";
  await vi.advanceTimersByTimeAsync(4000);
  expect(statuses.filter((s) => s.phase === "agent_waiting")).toHaveLength(1);
  phase = "completed";
  await vi.advanceTimersByTimeAsync(2000);
  expect(statuses.at(-1)?.phase).toBe("agent_completed");
  expect(pipeline.replay("app", "other-client")).toEqual([]);
  await vi.advanceTimersByTimeAsync(1800001);
  expect(pipeline.replay("app", "client")).toEqual([]);
  pipeline.stop();
});

it("stops monitoring after an hour", async () => {
  const { pipeline, feedback, statuses, adapter, config } = await setup();
  vi.useFakeTimers();
  config.t3.pollIntervalMs = 60000;
  adapter.classifyRun = () => "unknown";
  pipeline.submit(feedback("request_1"), "client", "thread");
  await vi.advanceTimersByTimeAsync(3600001);
  expect(statuses.at(-1)).toMatchObject({ phase: "failed", detail: "stopped monitoring" });
  pipeline.stop();
});

it("deduplicates ids and fingerprints, replaying the latest status", async () => {
  const { pipeline, feedback } = await setup();
  expect(pipeline.submit(feedback("request_1"), "client", "thread").result).toBe("accepted");
  expect(pipeline.submit(feedback("request_1"), "client", "thread").result).toBe("duplicate");
  expect(pipeline.submit(feedback("request_2", "request_1"), "client", "thread").result).toBe(
    "duplicate",
  );
  expect(pipeline.replay("app", "client")).toHaveLength(1);
  pipeline.stop();
});

it("keeps recently accessed request ids when the dedupe cache reaches 1000 entries", async () => {
  const { pipeline, feedback } = await setup();
  for (let i = 0; i < 1000; i++) pipeline.submit(feedback(`request_${i}`), "client", "thread");
  expect(pipeline.submit(feedback("request_0"), "client", "thread").result).toBe("duplicate");
  pipeline.submit(feedback("request_1000"), "client", "thread");
  expect(pipeline.submit(feedback("request_0", "new instruction"), "client", "thread").result).toBe(
    "duplicate",
  );
  expect(
    pipeline.submit(feedback("request_1", "another instruction"), "client", "thread").result,
  ).toBe("accepted");
  pipeline.stop();
});

it("cancels a request immediately before the worker starts", async () => {
  const { pipeline, feedback, send, statuses } = await setup();
  pipeline.submit(feedback("request_1"), "client", "thread");
  expect(pipeline.cancel("app", "request_1")).toBe(true);
  await new Promise((resolve) => setImmediate(resolve));
  expect(send).not.toHaveBeenCalled();
  expect(statuses.at(-1)?.phase).toBe("cancelled");
  pipeline.stop();
});

it("delivers three requests in FIFO order", async () => {
  const { pipeline, feedback, send, statuses } = await setup();
  for (const id of ["request_1", "request_2", "request_3"])
    pipeline.submit(feedback(id), "client", "thread");
  await vi.waitFor(() =>
    expect(statuses.filter((s) => s.phase === "agent_completed")).toHaveLength(3),
  );
  expect(send.mock.calls.map((call) => call[0]?.message.match(/request_[123]/)?.[0])).toEqual([
    "request_1",
    "request_2",
    "request_3",
  ]);
  pipeline.stop();
});

it("delivers FIFO and cancels queued requests without sending them", async () => {
  let release: (() => void) | undefined;
  const send = vi.fn(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { runId: null, delivery: "queued" as const };
  });
  const { pipeline, feedback, statuses } = await setup(send);
  pipeline.submit(feedback("request_1"), "client", "thread");
  pipeline.submit(feedback("request_2"), "client", "thread");
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  expect(pipeline.cancel("app", "request_2")).toBe(true);
  release?.();
  await vi.waitFor(() => expect(statuses.some((s) => s.phase === "agent_completed")).toBe(true));
  expect(send).toHaveBeenCalledTimes(1);
  expect(pipeline.cancel("app", "request_1")).toBe(false);
  pipeline.stop();
});

it("retries unavailable delivery then succeeds", async () => {
  const send = vi.fn(async () => ({ runId: null, delivery: "queued" as const }));
  send.mockRejectedValueOnce(new AdapterUnavailableError("down"));
  const { pipeline, feedback, statuses } = await setup(send);
  vi.useFakeTimers();
  pipeline.submit(feedback("request_1"), "client", "thread");
  await vi.advanceTimersByTimeAsync(1);
  expect(statuses.at(-1)?.detail).toContain("retrying");
  await vi.advanceTimersByTimeAsync(2000);
  expect(send).toHaveBeenCalledTimes(2);
  expect(statuses.at(-1)?.phase).toBe("agent_completed");
  pipeline.stop();
});

it("gives up after ten minutes and expires the fingerprint after 15 seconds", async () => {
  const send = vi.fn(async () => {
    throw new AdapterUnavailableError("down");
  });
  const { pipeline, feedback, statuses } = await setup(send);
  vi.useFakeTimers();
  pipeline.submit(feedback("request_1"), "client", "thread");
  await vi.advanceTimersByTimeAsync(610000);
  expect(statuses.at(-1)?.phase).toBe("failed");
  expect(pipeline.submit(feedback("request_2", "request_1"), "client", "thread").result).toBe(
    "accepted",
  );
  pipeline.stop();
});
