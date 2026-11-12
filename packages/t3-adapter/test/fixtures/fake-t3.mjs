#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

const args = process.argv.slice(2);
const statePath = process.env.FAKE_T3_STATE;

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
function ordinal(runId) {
  return Number(runId?.match(/:ordinal:(\d+)$/)?.[1] ?? 0);
}

async function main() {
  if (args[0] === "--version") {
    process.stdout.write("fake-t3 1.0.0\n");
    return;
  }
  if (!statePath) throw new Error("FAKE_T3_STATE is required");
  let stdin = "";
  if (args[0] === "thread" && args[1] === "send") {
    for await (const chunk of process.stdin) stdin += chunk.toString();
  }

  // Separate CLI processes share one state file; serialize their read/update/write.
  const lock = `${statePath}.lock`;
  for (let attempt = 0; ; attempt++) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if (error.code !== "EEXIST" || attempt >= 1000) throw error;
      await setTimeout(5);
    }
  }
  try {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    if (state.mode === "down") {
      process.stderr.write("Could not connect to T3 Code server\n");
      process.exitCode = 1;
      return;
    }
    const threads = state.threads ?? [];
    state.messages ??= {};
    state.runs ??= {};
    if (args[0] !== "thread") throw new Error("Unsupported command");
    if (args[1] === "list") {
      const projectIndex = args.indexOf("--project");
      const project = projectIndex >= 0 ? args[projectIndex + 1] : undefined;
      output(
        threads.filter(
          (thread) =>
            project === undefined || thread.projectId === project || thread.projectPath === project,
        ),
      );
      return;
    }
    const threadId = args[args[1] === "send" ? args.length - 2 : args.length - 1];
    const thread = threads.find((candidate) => candidate.threadId === threadId);
    if (!thread) {
      process.stderr.write(`Thread ${threadId} is no longer available.\n`);
      process.exitCode = 1;
      return;
    }
    thread.activeRunId ??= null;
    thread.latestRunId ??= null;
    thread.pendingRequestCount ??= 0;
    const messages = (state.messages[threadId] ??= []);
    if (thread.activeRunId && !state.runs[thread.activeRunId]) {
      state.runs[thread.activeRunId] = { threadId, status: "running", shows: 0 };
    }

    if (args[1] === "send") {
      const nextOrdinal =
        Math.max(
          ordinal(thread.latestRunId),
          ordinal(thread.activeRunId),
          ...Object.keys(state.runs)
            .filter((id) => state.runs[id].threadId === threadId)
            .map(ordinal),
        ) + 1;
      const runId = `run:thread:${encodeURIComponent(threadId)}:ordinal:${nextOrdinal}`;
      const messageId = `message:${threadId}:${messages.length + 1}`;
      messages.push({ role: "user", text: stdin, runId, messageId });
      thread.latestRunId = runId;
      state.runs[runId] = { threadId, status: thread.activeRunId ? "queued" : "running", shows: 0 };
      if (!thread.activeRunId) {
        thread.activeRunId = runId;
        thread.status = "running";
      }
      thread.runCount = nextOrdinal;
      thread.updatedAt = new Date().toISOString();
      await writeFile(statePath, JSON.stringify(state));
      output({
        threadId,
        link: thread.link,
        messageId,
        runId,
        status: "queued",
        delivery: "queued",
      });
      return;
    }
    if (args[1] !== "show") throw new Error("Unsupported command");
    if (state.autoComplete && thread.activeRunId) {
      const active = state.runs[thread.activeRunId];
      active.shows = (active.shows ?? 0) + 1;
      if (active.shows >= (state.completeAfterShows ?? 2)) {
        active.status = "completed";
        messages.push({
          role: "assistant",
          runId: thread.activeRunId,
          text: `Completed ${thread.activeRunId}`,
        });
        const queued = Object.entries(state.runs)
          .filter(([, run]) => run.threadId === threadId && run.status === "queued")
          .sort(([left], [right]) => ordinal(left) - ordinal(right))[0];
        thread.activeRunId = queued?.[0] ?? null;
        thread.status = queued ? "running" : "completed";
        thread.pendingRequestCount = 0;
        if (queued) queued[1].status = "running";
      }
    }
    await writeFile(statePath, JSON.stringify(state));
    const limitIndex = args.indexOf("--messages");
    const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : messages.length;
    output({ thread, messages: limit === 0 ? [] : messages.slice(-limit) });
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
