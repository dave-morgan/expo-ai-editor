# Brief: implement `@expo-ai/t3-adapter` and `expo-ai-bridge`

Repo: pnpm monorepo at repo root. Run pnpm as `npx -y pnpm@10.34.9 ...` (the global pnpm on this machine is broken). Node 24+/26. Strict TypeScript, ESM (`"type": "module"`, NodeNext, `.js` import suffixes), vitest 5. Mirror the layout of `packages/protocol` (package.json scripts `build`/`typecheck`/`test`, `tsconfig.json` + `tsconfig.build.json` extending `../../tsconfig.base.json`, output `dist/`).

The wire protocol is already defined in `packages/protocol/src/schemas.ts` (`@expo-ai/protocol`, workspace dependency `"workspace:*"`). **Use it, do not redefine message shapes.** If you truly need a protocol change, make it minimal, keep backwards-compatible, and update its tests.

Do not touch `packages/expo-ai-inspector`, `packages/inspector-transform` or `apps/`. Do not commit (sandbox cannot write .git); just leave files in place.

## Hard constraints

- Never use a shell string with user data. Spawn with an args array. Thread ids and project ids are validated with `SafeIdSchema` before use. The message body is always passed on **stdin** using `-` as the message argument.
- No arbitrary shell/file access from mobile requests. The only filesystem write triggered by a mobile request is saving a validated screenshot into the configured screenshots dir inside the project root.
- Never log tokens, pairing codes after use, or screenshot data.
- No direct access to T3 databases or files under `~/.t3/userdata`. Only the public `t3` CLI.

## Verified T3 Code interface (T3 0.1.9, tested on this machine)

The T3 desktop app installs a CLI launcher: `t3` on PATH or `%USERPROFILE%\.t3\bin\t3.cmd` (Windows) / `~/.t3/bin/t3` (POSIX). It talks to the running T3 server. Commands (all support `--json`):

- `t3 --version`
- `t3 thread list --json [--project <project id or path inside project>]` → JSON array:
  `[{"threadId":"d40449b0-...","projectId":"7495...","title":"...","link":"https://app.t3.codes/threads/...","status":"running"|"completed"|"idle"|"failed"|"interrupted"|"waiting"|...,"latestRunId":"run:thread:<urlencoded threadId>:ordinal:2","model":"claude-opus-5-5","archived"?:..., "settled":false,"parentThreadId":null,"createdAt":"...","updatedAt":"..."}]`
  Thread ids may contain a prefix like `mcp:42a5...` (colon allowed).
- `t3 thread show --json [--messages N] <threadId>` → `{"thread":{"threadId","projectId","title","link","status","latestRunId","activeRunId":string|null,"runCount","pendingRequestCount","archived",...},"messages":[{"role":"user"|"assistant","runId","text"}]}`.
  Unknown thread: prints `Thread <id> is no longer available.` (treat as not found; check exit code and stderr/stdout text).
- `t3 thread send --json <threadId> -` (message on stdin) → `{"threadId","link","messageId","runId":"run:thread:...:ordinal:2","status":"queued","delivery":"queued"}`. Semantics: a busy thread receives it as its next turn; nothing is interrupted. **There is no steer option in the CLI** → adapter capabilities: `queue: true, steer: false, attachments: false, listThreads: true, runStatus: true`.
- Observed run lifecycle after send: `thread.latestRunId` becomes our runId immediately; while a previous run is still active `activeRunId` is the older ordinal; when ours runs `activeRunId === ourRunId`; when done `status:"completed"`, `activeRunId:null`, `latestRunId` ≥ ours. `pendingRequestCount > 0` or status `waiting` means the agent waits for user input (approval/question) → phase `agent_waiting`. Status `failed` with latestRunId === ours → failed. `interrupted`/`cancelled` → failed with detail.
- There is no `project list` command. Projects are referenced by T3 project id or a filesystem path inside the project (passed to `--project`). `t3 project add <path>` exists but the bridge must NOT call it (document instead).

## Package 1: `packages/t3-adapter` → name `@expo-ai/t3-adapter`

Files:
- `src/agent-adapter.ts` — generic, agent-agnostic interface other adapters can implement:
  ```ts
  export interface AgentThread { threadId: string; title: string; status: string; updatedAt?: string; model?: string; link?: string; projectId?: string }
  export interface AgentThreadState extends AgentThread { activeRunId: string | null; latestRunId: string | null; pendingRequestCount: number; lastAssistantMessage?: string }
  export interface SendResult { runId: string | null; delivery: "queued" | "steered" | "started"; link?: string }
  export type RunPhase = "queued" | "working" | "waiting" | "completed" | "failed" | "unknown";
  export interface AgentAdapter {
    readonly id: string;
    capabilities(): AdapterCapabilities; // from @expo-ai/protocol
    diagnose(): Promise<DiagnosticReport>;
    listThreads(projectRef: string): Promise<AgentThread[]>;
    getThread(threadId: string): Promise<AgentThreadState>;
    sendMessage(input: { threadId: string; message: string; mode: DeliveryMode }): Promise<SendResult>;
    classifyRun(state: AgentThreadState, runId: string | null): RunPhase;
  }
  export interface DiagnosticReport { ok: boolean; checks: { name: string; ok: boolean; detail: string; fix?: string }[] }
  ```
  Typed errors: `AdapterUnavailableError` (CLI missing / server not running / timeout), `ThreadNotFoundError`, `AdapterProtocolError` (unparseable output). All extend `AgentAdapterError` with `code`.
- `src/command-runner.ts` — `CommandRunner = (args: string[], opts: { stdin?: string; timeoutMs: number }) => Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>`; default implementation with `child_process.spawn`. Windows `.cmd`/`.bat` launchers cannot be spawned without a shell: spawn `process.env.ComSpec || "cmd.exe"` with `["/d", "/s", "/c", <quoted command line>]` and `windowsVerbatimArguments: true`, where every arg has been validated against `/^[A-Za-z0-9._:\/\\ @=-]+$/` (reject otherwise) and is double-quoted. Message bodies always go through stdin. Kill on timeout (default 30 s). Strip ANSI.
- `src/resolve-cli.ts` — resolve command: explicit config `{ command, args? }` → env `T3_CLI` → `t3` found on PATH (search PATH + PATHEXT manually, no `which` dependency) → `~/.t3/bin/t3.cmd` or `~/.t3/bin/t3`. Return `{ command, prefixArgs, source }` or null.
- `src/run-classifier.ts` — pure `classifyRun(state, runId)`: parse `:ordinal:(\d+)` from run ids (urlencoded thread ids inside run id are fine — only the trailing ordinal matters). Rules: runId null → "unknown"; active ordinal < ours → "queued"; active === ours → pendingRequestCount>0 || status==="waiting" ? "waiting" : "working"; active > ours → "completed"; active null: latest ordinal ≥ ours and status in completed/idle → "completed"; status failed/interrupted/cancelled/error and latest === ours → "failed"; latest < ours → "queued". Unit-test exhaustively.
- `src/t3-cli-adapter.ts` — `class T3CliAdapter implements AgentAdapter` with options `{ runner?, cli?: {command,args}, timeoutMs?, env? }`. Parse JSON defensively with zod (passthrough, only required fields). `listThreads(projectRef)` runs `thread list --json --project <ref>`, filters out `archived === true` and child threads (`parentThreadId` non-null), sorts by updatedAt desc. `sendMessage` maps mode: `queue` → send; `steer`/`auto` → send (queue) and return delivery `"queued"` (the bridge reports the downgrade). `diagnose()` checks: CLI resolved (fix: "Install/open T3 Code desktop once, or set T3_CLI"), `--version` runs, `thread list --json` succeeds (fix: "Start T3 Code (desktop app or `t3 serve`)"), reports capabilities incl. "steer unsupported by CLI".
- `src/index.ts` exports all.
- `test/fixtures/fake-t3.mjs` — executable Node script emulating the CLI above using a JSON state file at `process.env.FAKE_T3_STATE` (threads + messages + runs). Supports `--version`, `thread list|show|send`. `send` appends a user message, creates the next ordinal run, sets latestRunId; if no active run, marks it active. Behaviour knobs via state file: `mode: "ok"|"down"` (down → exit 1 with stderr "Could not connect to T3 Code server"), `autoComplete: true` (each `show` call advances the active run: active → completed after N shows, adding an assistant message). Unknown thread → print `Thread <id> is no longer available.` exit 1.
- Tests: `test/run-classifier.test.ts`, `test/t3-cli-adapter.test.ts` (with an in-memory fake runner: arg construction, stdin usage, parsing, error mapping, timeout, arg validation rejects injection like `a"&calc`), `test/fake-cli.integration.test.ts` (real spawn of `node fake-t3.mjs` through the adapter: list, show, send, queue while busy, completion, down/unavailable, not-found).

## Package 2: `packages/expo-ai-bridge` → name `expo-ai-bridge`

Dependencies: `ws`, `zod`, `@expo-ai/protocol`, `@expo-ai/t3-adapter`. No other runtime deps (use `node:util` parseArgs, `node:http`, `node:crypto`, `node:fs`). `bin: { "expo-ai-bridge": "./dist/cli.js" }` with shebang.

### Config

`expo-ai-bridge.config.json` (looked up in cwd, or `--config <path>`), zod-validated, paths resolved relative to the config file:
```json
{
  "host": "127.0.0.1",
  "port": 8790,
  "projects": [
    {
      "id": "example-expo",
      "name": "Example Expo app",
      "root": "./apps/example-expo",
      "t3Project": ".",
      "defaultThreadId": "optional-thread-id",
      "allowedThreadIds": ["optional allowlist; when set only these may be selected"]
    }
  ],
  "screenshots": { "enabled": true, "dir": ".expo-ai/screenshots", "maxBytes": 4500000 },
  "t3": { "command": "optional", "args": [], "pollIntervalMs": 2000, "timeoutMs": 30000 },
  "pairing": { "codeTtlSeconds": 600, "tokenTtlHours": 12, "sessionsFile": "optional, default ~/.expo-ai-bridge/sessions.json" }
}
```
`t3Project` is a T3 project id or a path (relative paths resolved against the config dir) passed to `t3 thread list --project`. CLI flags can define a single project without a config file: `--project-id`, `--project-root`, `--t3-project`, `--thread`, plus `--host`, `--port`, `--lan` (= host `0.0.0.0`). Print a clear warning whenever host is not loopback ("bridge reachable from your network; pairing token required; never expose to the internet").

### CLI (`src/cli.ts`)

- `expo-ai-bridge start` (default): starts server, prints URL(s) (all non-internal IPv4 addresses when bound to 0.0.0.0), the 6-digit pairing code and its expiry. When stdin is a TTY: key `p` = new pairing code, `t` = list threads, `q`/Ctrl-C = quit.
- `expo-ai-bridge doctor`: validates config + runs adapter `diagnose()` for each project + lists threads; exits non-zero on failure; prints actionable fixes.
- `expo-ai-bridge threads [--project-id x]`: lists threads for project(s).

### Library API (`src/index.ts`)

`createBridge(config: BridgeConfig, deps?: { adapter?: AgentAdapter; logger?: Logger; now?: () => number; watcherFactory?: ... }) → { start(): Promise<{ port: number; host: string }>; stop(): Promise<void>; getPairingCode(): { code: string; expiresAt: Date }; regeneratePairingCode(): ... }`. Used by tests with port 0.

### HTTP + WebSocket (single port)

- `GET /health` → `{ ok: true, name: "expo-ai-bridge", version, protocolVersion }`. No secrets, no project list.
- `POST /pair` body `PairRequestSchema` (≤ 4 KB) → `PairResponseSchema`. Code: 6 random digits (`crypto.randomInt`), TTL from config, reusable by multiple devices within TTL; constant-time compare; per-IP limit 5 attempts / minute (429); after 10 total failures the code is invalidated and a new one must be generated (logged to console). `projectId` must be a configured project (else 404 `unknown_project`). Token = 32 random bytes base64url; persist only `sha256(token)` with `{ projectId, clientId, deviceName, expiresAt }` to sessions file (mode 0600, create dir). Expired sessions pruned on load.
- WebSocket at path `/ws` (`ws` with `maxPayload: LIMITS.maxFrameBytes`; reject other paths). First frame must be `hello` within 10 s else close 4408. Validate protocolVersion (`unsupported_version` fatal error + close 4400), token (hash lookup, not expired, `unauthorized` fatal + close 4401), token's projectId === hello.projectId (`unauthorized`). Then send `welcome` and `threads`.
- All frames decoded with `decodeClientMessage`; invalid → `error invalid_message` (non-fatal); oversize → close 1009 by ws.
- Heartbeat: ws ping every 20 s, terminate if no pong; also respond to protocol `ping` with `pong`.

### Threads

- `threads.list` → adapter.listThreads(project.t3Project) → `threads` (on adapter failure send `threads` with `threads: []` and `error` text from diagnostics).
- `threads.select` → must be in current thread list (and in `allowedThreadIds` when configured) → remember as the project's selected thread for the bridge lifetime (shared by all devices of that project) → reply `threads`. Initial selection = `defaultThreadId` (validated lazily) or null.

### Feedback pipeline

1. `feedback.submit`: `feedback.projectId` must equal session project. Resolve thread: `feedback.threadId ?? selected`; none → `feedback.ack rejected` + `error no_thread_selected`. Thread must pass allowlist when configured.
2. Dedupe: same `requestId` seen (LRU 1000) → `ack duplicate` and re-send its latest status. Same fingerprint `sha256(threadId + instruction + selection.source?.file + line + elementType)` within 15 s → `ack duplicate` with reason.
3. `ack accepted`, status `received`, enqueue in a per-thread FIFO queue (status `queued`).
4. Worker per thread (one in-flight delivery at a time): if screenshot present and screenshots enabled: decode base64, verify JPEG (`FF D8 FF`) / PNG magic bytes and size ≤ maxBytes, write `<projectRoot>/<dir>/<requestId>.<jpg|png>` (dir must resolve inside project root), and ensure `<projectRoot>/.expo-ai/.gitignore` containing `*` exists. If screenshots are disabled, drop it and mention that in the status detail.
5. Build prompt (`src/prompt.ts`, below), call `adapter.sendMessage`. On `AdapterUnavailableError`: keep queued, status `queued` with detail "T3 Code not reachable — retrying", exponential backoff 2 s → 30 s, give up after 10 min with status `failed`. On `ThreadNotFoundError`: status `failed`. On success: status `submitted` (detail includes delivery; if requested mode was steer/auto and capability steer=false, detail says "steer is not supported by the T3 CLI; queued as next turn instead").
6. Run monitor: poll `adapter.getThread` every `pollIntervalMs`, map `classifyRun` → `queued`(only emit if changed) / `agent_working` / `agent_waiting` / `agent_completed` (detail: first 500 chars of last assistant message when available) / `agent_failed`. Emit only on phase change. Stop at terminal phase; stop after 60 min with detail "stopped monitoring".
7. `feedback.cancel`: if still in the bridge queue → remove, status `cancelled`; if already delivered → status unchanged and `error` (non-fatal) "already delivered to T3; cancel it in T3 Code".

Statuses are broadcast to every socket of the project. Keep the last status per request for 30 min; on `hello`, replay last statuses for requests whose clientId matches.

### Source change + refresh tracking

- On first submission per project start a watcher on the project root (`fs.watch(root, { recursive: true })`; wrap so tests can inject). Ignore `node_modules`, `.git`, `.expo`, `.expo-ai`, `dist`, `build`, `ios/build`, `android/build`, `android/.gradle`, `*.log`. Debounce 300 ms.
- Changes are attributed to the project's most recent request that is in phase submitted/agent_* or completed within the last 120 s. Emit `source_changed` with `changedFiles` (POSIX, relative to project root, max 50). State the attribution heuristic in docs comments.
- If any changed file matches native-config patterns — `app.json`, `app.config.{js,ts,mjs,cjs}`, `package.json`, `eas.json`, `ios/**`, `android/**`, `plugins/**`, `*.podspec`, `Podfile*`, `react-native.config.js` — additionally emit `native_rebuild_required` with detail listing those files ("may need `npx expo prebuild` / a new development build").
- `refresh.event` from inspector: if the project's latest request has reached `source_changed`, `applied`/`full-reload` → `refresh_observed`, `error` → `refresh_failed` with message. Otherwise ignore (don't claim refresh before a source change).

### Prompt (`src/prompt.ts`)

Pure function `buildAgentPrompt({ feedback, project, screenshotPath?, appRootRelative?, capabilitiesNote? }) => string`. Compact, no boilerplate, never invent data (omit any line whose data is missing). Shape:

```
[Expo AI Inspector] Visual change request from the running app.

Instruction (voice, transcribed on device):
"Make this heading 20% smaller and reduce the padding underneath it."

Selected element
- App root: apps/example-expo (file paths below are relative to it)
- Screen: /profile · ios 18.2 · window 393×852
- Element: <Text> "Welcome back"
- Source (JSX call site): src/components/ProfileHeader.tsx:42:6 — confidence high (babel-transform)
- Component: ProfileHeader (defined at src/components/ProfileHeader.tsx:12)
- Component stack: ProfileHeader › ProfileScreen › Stack (innermost first, library frames marked [lib])
- testID: profile-title · accessibility label: "..."
- Bounds: x 24, y 120, 280×40 dp
- Style: fontSize 28, fontWeight "700", marginBottom 16
- Confidence notes: ...
- Screenshot: .expo-ai/screenshots/<requestId>.jpg (relative to app root)

Edit the source files to implement this change — do not just describe it. Keep the change scoped to the selected element unless the instruction says otherwise. Expo Fast Refresh will pick up saved files.
```
`inputMethod` → "voice, transcribed on device" / "typed" / "voice, edited by the developer". When `selection` is absent say "No element selected." When confidence is low/none add "Source location could not be determined reliably; locate the element using the details above."

### Tests (vitest) — required

Unit: config loading/validation & flag merge; pairing/auth (success, wrong code, lockout, expired code, expired token, project mismatch, rate limit, hashes-only persistence); dedupe (requestId + fingerprint window); per-thread queue (FIFO, retry while unavailable then success, give-up, cancel queued vs delivered); prompt builder (full selection, minimal selection, no selection, low confidence — assert no "undefined"/"null" text); screenshot validation (magic bytes, size, path containment); native-change detection.

Integration (`test/bridge.integration.test.ts`): start a real bridge on port 0 with `T3CliAdapter` pointed at `node packages/t3-adapter/test/fixtures/fake-t3.mjs` (temp state file, temp project root), real `ws` client: health; pair; hello → welcome + threads; select thread; submit → ack accepted → statuses received/queued/submitted/agent_working/agent_completed in order; queue handling while the fake thread is busy (second submission is `queued` until first completes); duplicate submit → ack duplicate; unauthorized token → fatal error + close 4401; unknown project; invalid frame → invalid_message; T3 down → status queued with retry detail, then bring fake back up → submitted; reconnection: close socket mid-run, reconnect with same token → replayed status and later completion; writing a file into the temp project root after submit → `source_changed` with that file; writing `app.json` → `native_rebuild_required`; `refresh.event applied` after source change → `refresh_observed`.

Make `npx -y pnpm@10.34.9 -r --filter "./packages/**" run build`, `... run typecheck` and `... run test` pass. Add a short `README.md` in each package (usage, config, CLI). When done, print a summary of files, test counts, and any deviations from this brief.
