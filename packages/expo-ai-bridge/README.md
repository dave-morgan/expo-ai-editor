# expo-ai-bridge

Connect Expo AI Inspector to an existing T3 Code thread through the public T3 CLI. Start T3 Code first and add your Expo project there; the bridge never creates projects or accesses T3's database.

```sh
npx -y pnpm@10.34.9 --filter @dave-morgan/expo-ai-bridge... run build
npx -y pnpm@10.34.9 --filter @dave-morgan/expo-ai-bridge start --project-id example-expo --project-root ./apps/example-expo
```

Alternatively create `expo-ai-bridge.config.json` in the directory where you launch the bridge:

```json
{
  "host": "127.0.0.1",
  "port": 8790,
  "projects": [
    {
      "id": "example-expo",
      "name": "Example Expo app",
      "root": "./apps/example-expo",
      "t3Project": "./apps/example-expo"
    }
  ],
  "screenshots": { "enabled": true, "dir": ".expo-ai/screenshots", "maxBytes": 4500000 },
  "t3": { "pollIntervalMs": 2000, "timeoutMs": 30000 },
  "pairing": { "codeTtlSeconds": 600, "tokenTtlHours": 12 }
}
```

Paths resolve relative to the config file. `t3Project` accepts an existing T3 project id or a project directory. Projects can set `defaultThreadId` and `allowedThreadIds`; an allowlist restricts thread selection and submission. Set `t3.command` and `t3.args` to override CLI discovery, or use `T3_CLI`.

Run `expo-ai-bridge start` (the default), `expo-ai-bridge doctor`, or `expo-ai-bridge threads --project-id example-expo`. Use `--config <path>` for another config. Without a config, `--project-id`, `--project-root`, `--t3-project`, and `--thread` configure one project. `--host`, `--port`, and `--lan` override binding; `--lan` prints each network IPv4 URL for connecting a phone. Never expose the bridge to the internet.

The terminal shows a six-digit pairing code and its expiry. Pair the inspector with the project id and code; each device receives a project-scoped bearer token. In an interactive terminal press `p` for a new code, `t` to list threads, or `q`/Ctrl-C to stop. Codes last ten minutes by default, tokens twelve hours. Only token hashes are persisted, by default in `~/.expo-ai-bridge/sessions.json`.

`GET /health`, `POST /pair`, and WebSocket `/ws` share the configured port. WebSocket clients authenticate with the protocol `hello` frame; protocol types and codecs come from `@dave-morgan/expo-ai-protocol`. The bridge acknowledges feedback, sends lifecycle statuses, and replays recent statuses after reconnecting. T3 CLI delivery always queues the next turn: requests for `steer` or `auto` report this downgrade. Cancellation removes feedback still in the bridge queue; cancel delivered work in T3 Code.

Screenshots are validated and saved beneath the project root, and their paths are included in prompts. Disable them with `screenshots.enabled: false`. Source changes are attributed heuristically to the most recent submitted request, including requests completed within the last 120 seconds; concurrent edits may belong to someone else. Refresh is reported only after a source change and an inspector refresh event. Native configuration changes report that Expo prebuild or a new development build may be needed.

Library usage:

```ts
import { createBridge, loadConfig } from "expo-ai-bridge";

const config = await loadConfig({ configPath: "./expo-ai-bridge.config.json" });
const bridge = createBridge(config);
await bridge.start();
// Pair using bridge.getPairingCode(), then connect an inspector.
await bridge.stop();
```

`createBridge(config, { adapter, logger, now, watcherFactory })` supports injected dependencies. Use port `0` in tests to allocate an available port; `start()` returns its host and port.
