# T3 Code integration

## What was investigated

Verified on this machine against **T3 Code 0.1.9** (desktop app; server on `127.0.0.1:3773`).

| Surface | Finding | Decision |
| --- | --- | --- |
| `t3` CLI (`%USERPROFILE%\.t3\bin\t3.cmd`, `~/.t3/bin/t3`) | Installed by the desktop app. `t3 thread list/show/send/start --json` talk to the running server using the local owner's credentials. Documented in `t3 thread --help`. | **Used** (primary adapter) |
| T3 MCP server (`t3_thread_send`, `t3_thread_list`, ...) | Exposed to agents running *inside* T3 threads, not to external processes. | Not used |
| WebSocket RPC on port 3773 | Internal app protocol; needs a bearer session (`t3 auth session issue`). Not documented as stable. | Not used; candidate for a future adapter |
| T3 SQLite state (`~/.t3/userdata/*.sqlite`) | Private storage. | **Never touched** |

Observed CLI contract (all `--json`):

```text
t3 thread list --json --project <id|path>
  → [{ threadId, projectId, title, status, latestRunId, model, link, parentThreadId, updatedAt, ... }]
t3 thread show --json --messages N <threadId>
  → { thread: { status, activeRunId, latestRunId, runCount, pendingRequestCount, ... }, messages: [{ role, runId, text }] }
t3 thread send --json <threadId> -        (message on stdin)
  → { threadId, messageId, runId: "run:thread:<id>:ordinal:N", status: "queued", delivery: "queued" }
```

`thread send` semantics (from `t3 thread send --help` and observed): *"A busy thread gets it as
its next turn; nothing is interrupted."* The message appears in the existing thread's conversation,
which remains the single source of truth. No second Claude session is created.

## Message behaviour

| Mode | T3 CLI support | Bridge behaviour |
| --- | --- | --- |
| `queue` (default) | Yes | Delivered as the thread's next turn |
| `steer` | **No** (CLI has no steer flag) | Delivered as next turn; status detail says steering is unsupported |
| `auto` | Partially | Same as queue |

The inspector disables the `steer` option when the adapter reports `steer: false`.

## Run tracking

After `send`, the bridge polls `thread show` every `pollIntervalMs` (default 2 s) and classifies the
run by comparing the trailing `:ordinal:N` of our `runId` with `activeRunId` / `latestRunId`:

| Observation | Phase |
| --- | --- |
| `activeRunId` ordinal < ours | `queued` (thread busy with an earlier turn) |
| `activeRunId` = ours | `agent_working` (`agent_waiting` if `pendingRequestCount > 0` or status `waiting`) |
| `activeRunId` > ours, or none active and status `completed`/`idle` | `agent_completed` |
| status `failed`/`interrupted`/`cancelled` on our run | `agent_failed` |

## Prompt

`packages/expo-ai-bridge/src/prompt.ts` builds a compact message: the instruction and how it was
captured, the app root relative to the T3 project, screen and device, element, JSX source with
confidence, owning component, component stack, testID/accessibility, bounds, style, confidence
notes, screenshot path, and one line telling the agent to edit the files rather than explain.
Missing data is omitted, never filled in.

Screenshots: the CLI has no attachment flag, so the bridge saves the JPEG under
`<app>/.expo-ai/screenshots/<requestId>.jpg` (git-ignored automatically) and references the path.

## Setup

1. Install and open T3 Code once (this installs the `t3` launcher).
2. Add the repository (or the Expo app folder) as a T3 project: in the app, or
   `t3 project add <path>`.
3. Start or open a thread in that project. This is the thread the inspector will target.
4. Point the bridge at it: `"t3Project": "<project path or id>"` in `expo-ai-bridge.config.json`.
5. `expo-ai-bridge doctor` must print `OK server` and list your threads.

Override CLI discovery with `T3_CLI=/path/to/t3` or `"t3": { "command": "...", "args": [] }`.

## Compatibility diagnostics

`expo-ai-bridge doctor` checks, in order: CLI found (and where), `t3 --version`, server reachable
(`thread list` succeeds), capabilities. Each failure prints a fix. If a future T3 version removes
the CLI, the adapter reports `AdapterUnavailableError`; requests stay queued, then fail with the
diagnostic after 10 minutes. The bridge does **not** fall back to database writes, terminal
injection or launching its own agent.
