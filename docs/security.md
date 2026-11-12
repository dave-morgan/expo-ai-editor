# Security

The bridge lets a phone ask a coding agent, which can edit files and run commands on your machine,
to do work. Treat it like any development server that can trigger code changes.

## Model

- **No credentials on the phone.** The app never holds Claude, OpenAI or T3 credentials. T3 is
  reached only by the bridge, through the local `t3` CLI running as you.
- **Pairing.** The bridge prints a 6-digit code (cryptographically random, 10-minute TTL). A device
  exchanges it at `POST /pair` for a 256-bit bearer token scoped to one project and the device's
  client id (12-hour TTL). Codes are compared in constant time, attempts are rate-limited to 5 per
  minute per IP, and the code is invalidated after 10 failures.
- **Token storage.** The bridge persists only SHA-256 hashes of tokens
  (`~/.expo-ai-bridge/sessions.json`, mode 0600). The device stores its token with
  `expo-secure-store` (Keychain / Keystore) when installed, otherwise in memory.
- **Authenticated WebSocket.** The first frame must be `hello` with a valid token for the requested
  project within 10 seconds, or the socket is closed.
- **Project allowlist.** Only projects in the bridge config exist. Threads can be restricted with
  `allowedThreadIds`.
- **Validation and limits.** Every frame is validated against `@expo-ai/protocol` (zod). Frames are
  capped at 8 MB, instructions at 4 000 characters, screenshots at ~4.5 MB (JPEG/PNG magic bytes
  checked, written only inside `<app>/.expo-ai/screenshots`). Ids that reach the CLI must match
  `[A-Za-z0-9][A-Za-z0-9._:-]*`.
- **No shell execution from requests.** The only command the bridge runs is the `t3` CLI with a
  fixed argument list. User text is passed on stdin, never on a command line. On Windows, `.cmd`
  launchers are invoked through `cmd /d /s /c` with an allowlisted character set.
- **Audio.** Recognition runs in the OS speech service with `requiresOnDeviceRecognition`. The
  inspector sends only the transcript. Nothing is recorded to disk.
- **Production.** `AIInspector` renders nothing unless `__DEV__`. The Babel transform is a no-op
  for production bundles. The config plugin adds only permission strings (remove the plugin from
  production configs if you do not want those strings in store builds).

## Network exposure

- Default bind is `127.0.0.1`. Use `adb reverse` for Android, the simulator for iOS.
- `--lan` binds `0.0.0.0` so a phone on Wi-Fi can connect. Pairing still applies, but traffic is
  plain `ws://` on your LAN: use it only on networks you trust.
- **Never** expose the bridge to the internet (port forwarding, public tunnels). For remote
  devices use a private overlay network (Tailscale, WireGuard) and bind to that interface with
  `--host <tailnet-ip>`.

## What the agent can do

The agent runs with whatever permissions its T3 thread has (for example `full-access`). A spoken
instruction is just another message in that thread: review the agent's changes as you would any
other turn. The prompt asks for scoped edits but does not sandbox the agent.
