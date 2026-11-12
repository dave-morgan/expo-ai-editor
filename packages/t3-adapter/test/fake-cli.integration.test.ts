import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AdapterProtocolError,
  AdapterUnavailableError,
  ThreadNotFoundError,
} from "../src/agent-adapter.js";
import { T3CliAdapter } from "../src/t3-cli-adapter.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-t3.mjs", import.meta.url));
let directory: string;
let statePath: string;
let adapter: T3CliAdapter;
const initial = () => ({
  mode: "ok",
  autoComplete: true,
  completeAfterShows: 2,
  threads: [
    {
      threadId: "mcp:42",
      projectId: "project",
      title: "Example",
      status: "idle",
      activeRunId: null,
      latestRunId: null,
      pendingRequestCount: 0,
    },
  ],
  messages: {},
  runs: {},
});
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "t3-cli-test-"));
  statePath = join(directory, "state.json");
  await writeFile(statePath, JSON.stringify(initial()));
  adapter = new T3CliAdapter({
    cli: { command: process.execPath, args: [fixture] },
    env: { FAKE_T3_STATE: statePath },
  });
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("real fake CLI process", () => {
  it("diagnoses, lists and shows threads", async () => {
    expect((await adapter.diagnose()).ok).toBe(true);
    expect(await adapter.listThreads("project")).toMatchObject([
      { threadId: "mcp:42", title: "Example" },
    ]);
    expect(await adapter.listThreads("other-project")).toEqual([]);
    expect(await adapter.getThread("mcp:42")).toMatchObject({
      activeRunId: null,
      pendingRequestCount: 0,
    });
  });
  it("sends stdin, observes working and completion, and saves messages", async () => {
    const sent = await adapter.sendMessage({
      threadId: "mcp:42",
      message: 'Change "heading" & padding\nNext line',
      mode: "steer",
    });
    expect(sent.delivery).toBe("queued");
    expect(adapter.classifyRun(await adapter.getThread("mcp:42"), sent.runId)).toBe("working");
    const completed = await adapter.getThread("mcp:42");
    expect(adapter.classifyRun(completed, sent.runId)).toBe("completed");
    expect(completed.lastAssistantMessage).toContain("Completed");
    const saved = JSON.parse(await readFile(statePath, "utf8"));
    expect(saved.messages["mcp:42"][0].text).toBe('Change "heading" & padding\nNext line');
  });
  it("queues a second run without interrupting the active run", async () => {
    const first = await adapter.sendMessage({
      threadId: "mcp:42",
      message: "First",
      mode: "queue",
    });
    const second = await adapter.sendMessage({
      threadId: "mcp:42",
      message: "Second",
      mode: "auto",
    });
    const busy = await adapter.getThread("mcp:42");
    expect(busy.activeRunId).toBe(first.runId);
    expect(busy.latestRunId).toBe(second.runId);
    expect(adapter.classifyRun(busy, second.runId)).toBe("queued");
    const next = await adapter.getThread("mcp:42");
    expect(adapter.classifyRun(next, first.runId)).toBe("completed");
    expect(adapter.classifyRun(next, second.runId)).toBe("working");
    await adapter.getThread("mcp:42");
    expect(adapter.classifyRun(await adapter.getThread("mcp:42"), second.runId)).toBe("completed");
  });
  it("maps server down then recovers", async () => {
    await writeFile(statePath, JSON.stringify({ ...initial(), mode: "down" }));
    await expect(adapter.listThreads("project")).rejects.toBeInstanceOf(AdapterUnavailableError);
    await writeFile(statePath, JSON.stringify(initial()));
    expect(await adapter.listThreads("project")).toHaveLength(1);
  });
  it("maps unknown thread errors for show and send", async () => {
    await expect(adapter.getThread("gone")).rejects.toBeInstanceOf(ThreadNotFoundError);
    await expect(
      adapter.sendMessage({ threadId: "gone", message: "Change", mode: "queue" }),
    ).rejects.toBeInstanceOf(ThreadNotFoundError);
  });
  it.runIf(process.platform === "win32")(
    "executes validated cmd launchers with spaces in the path",
    async () => {
      const launcher = join(directory, "fake t3.cmd");
      await writeFile(launcher, `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`);
      const cmdAdapter = new T3CliAdapter({
        cli: { command: launcher },
        env: { FAKE_T3_STATE: statePath },
      });
      expect(await cmdAdapter.listThreads("project")).toHaveLength(1);
      await expect(cmdAdapter.getThread('a"&calc')).rejects.toBeInstanceOf(AdapterProtocolError);
      expect(
        (
          await cmdAdapter.sendMessage({
            threadId: "mcp:42",
            message: 'safe stdin " & body',
            mode: "queue",
          })
        ).runId,
      ).toContain(":ordinal:1");
    },
  );
});
