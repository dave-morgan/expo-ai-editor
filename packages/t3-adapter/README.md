# @expo-ai/t3-adapter

An agent adapter backed only by the public T3 Code CLI. It lists existing threads,
queues messages through stdin, and monitors run ordinals without interrupting an
active run. T3 Code desktop or `t3 serve` must be running.

```ts
import { T3CliAdapter } from "@expo-ai/t3-adapter";

const adapter = new T3CliAdapter();
const report = await adapter.diagnose();
const threads = await adapter.listThreads("/path/to/project");
const thread = threads[0];
if (!thread) throw new Error("Select an existing T3 thread first");
const sent = await adapter.sendMessage({
  threadId: thread.threadId,
  message: "Reduce the title padding.",
  mode: "queue",
});
const state = await adapter.getThread(thread.threadId);
console.log(adapter.classifyRun(state, sent.runId));
```

CLI resolution order: constructor `cli: { command, args? }`, the `T3_CLI`
environment variable (an executable path, without embedded arguments), PATH and
PATHEXT, then `~/.t3/bin/t3.cmd` or `~/.t3/bin/t3`. Use `args` for a wrapper's
prefix arguments. `timeoutMs` defaults to 30 seconds. `env` overrides subprocess
environment variables; `runner` injects a `CommandRunner` for another execution
boundary. Windows `.cmd`/`.bat` arguments are validated and quoted; messages
always use stdin and may contain arbitrary text.

`listThreads` accepts an existing T3 project id or a path inside the project. T3
does not provide `project list`. Register new projects yourself with
`t3 project add <path>`; the adapter never registers projects.

Capabilities are `queue`, `listThreads`, and `runStatus`. Steering and attachments
are unsupported by the CLI. Requests using `steer` or `auto` are queued, and the
returned `delivery` is always `queued`. Screenshot paths can be included in the
message by the caller; the adapter does not attach or read files.

Exports include the generic `AgentAdapter` interface, thread and diagnostic
types, the pure `classifyRun` function, CLI resolver and runner factory, and typed
`AgentAdapterError` subclasses: `AdapterUnavailableError`, `ThreadNotFoundError`,
and `AdapterProtocolError`. Check the error's `code` when crossing process
boundaries.

Run `npx -y pnpm@10.34.9 --filter @expo-ai/t3-adapter build`, `typecheck`, or
`test` from the workspace root (use `npx.cmd` in restricted PowerShell).

The integration fixture is `test/fixtures/fake-t3.mjs`, launched with Node and
`FAKE_T3_STATE` pointing at a JSON file. State contains `threads` (an array),
`messages` (a map of thread ids to message arrays), and `runs` (a map of run ids
to `{ threadId, status, shows }`). Set `mode: "down"` to simulate a stopped
server. Set `autoComplete: true` to finish active runs after `completeAfterShows`
polls (default 2). A completed run adds an assistant message and starts the next
queued run. The fixture serializes its own state updates across CLI processes.
