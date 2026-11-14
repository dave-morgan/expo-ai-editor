# Limitations and validation status

## What was validated, and how

Environment: Windows 11, Node 26, T3 Code 0.1.9 desktop (real server, real Claude Code thread on
`claude-opus-5-5`), Expo SDK 58 / React Native 0.88.1 / React 19.3 development build on an
**Android 15 (API 35) x86_64 emulator**, Metro in watch mode, bridge on `127.0.0.1` via
`adb reverse`. Date: 2026-11-12.

| #   | Manual step                    | Result                                                                                                                                                                                                 |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Start bridge                   | ✅ `expo-ai-bridge doctor` found `t3.cmd`, t3 v0.1.9, server reachable, listed threads                                                                                                                 |
| 2   | Start T3 Code                  | ✅ existing desktop instance, existing project and thread                                                                                                                                              |
| 3   | Start Expo                     | ✅ dev client built with `expo prebuild` + Gradle, Metro `expo start --dev-client`                                                                                                                     |
| 4   | Connect device                 | ✅ Android emulator. ⚠️ **No physical iPhone or Android phone was available**                                                                                                                          |
| 5   | Select a heading               | ✅ Fabric `findNodeAtPoint` hit test; highlight matched the text bounds exactly; nested `ProfileHeader › AppText › Text` resolved, confidence high                                                     |
| 6   | Dictate a font-size change     | ❌ **Not verified.** The headless emulator has no microphone; speech capability checks and error handling are unit-tested only. Instructions were typed                                                |
| 7   | Verify transcript              | ⚠️ Typed path verified; voice path not verified                                                                                                                                                        |
| 8   | Submit to existing T3 thread   | ✅ three submissions, all delivered with `t3 thread send` as next turns                                                                                                                                |
| 9   | Message appears in T3          | ✅ read back with `t3 thread show`: structured prompt with instruction, source, component stack, style, bounds, screenshot path                                                                        |
| 10  | Agent changes the correct file | ✅ "20% smaller" → `app/index.tsx` usage (32 → 25.6); "brand green, halve space" → `src/components/ProfileHeader.tsx`; "orange accent value" → `StatCard.tsx` + `app/profile.tsx` (this instance only) |
| 11  | Expo refreshes the device      | ✅ Fast Refresh applied without reload; inspector showed Delivered → Agent done → Files changed → **Refreshed**                                                                                        |

Also verified on device: pairing with a 6-digit code, token surviving a full app reload
(expo-secure-store), automatic reconnect after a bridge restart with the thread choice restored,
thread picker listing real T3 threads, screenshot capture saved to `.expo-ai/screenshots`.

Screenshots: [selection](images/selection-nested.png), [thread picker](images/thread-picker.png),
[status](images/status-refreshed.png), [result](images/after-refresh.png).

### Physical Android (2026-11-13)

First integration into a real, existing app (Expo SDK 58, bun, Expo Router) on a **physical
Pixel 6 (Android 16) over USB** with `adb reverse`: pair, select element, typed instruction,
agent edit, Fast Refresh all worked end to end
([issue #1](https://github.com/dave-morgan/expo-ai-editor/issues/1)). It took host-side
workarounds that are now absorbed by the packages and docs: release tarballs and GitHub Packages publishing,
[an existing-app checklist](existing-app.md) with a Metro helper, worktree → main-checkout
mapping in the bridge, a `/health` link check in the pair sheet that tells "not the bridge"
(proxy, wrong port) apart from bridge errors, `expo-ai-bridge pair-code` and automatic code
rotation, a [USB troubleshooting guide](physical-android.md), and an explicit online-recognition
fallback when the on-device dictation model cannot be downloaded (Android error 5 for `en-AU`).

**Not verified**: iOS (no macOS available), physical iPhone, on-device speech recognition with
an installed model (the `en-AU` model download failed on the Pixel 6; dictation was not used),
`--lan` binding from a phone over Wi-Fi, web. The issue #1 fixes are unit/integration-tested;
they have not yet been re-run on the physical device.

Defects found during device testing and fixed: forwarded `{...props}` copied source tags into
library internals (wrong owner component); inspector client id not persisted (re-pair after
reload); Windows `fs.watch` reporting directories and read-only access as changes (false "native
rebuild required"); agents' atomic-write temp files reported as changes; Fast Refresh arriving
before the debounced change event was dropped.

## Automated tests

`npx -y pnpm@10.34.9 test`: protocol, transform, inspector (pure logic: metadata, hit picking,
state machine, bridge client with a fake socket, discovery, speech capability, refresh observer),
T3 adapter (unit + real-spawn integration against a fake `t3` CLI), bridge (config, pairing,
dedupe, queues, prompt, screenshots, change detection, full WebSocket integration against the fake
CLI). There are no React Native component-render tests (Jest + RN renderer); UI behaviour was
validated on the emulator instead.

## Known limitations

- **Steering**: T3's CLI only queues. `steer`/`auto` are downgraded to queue and the developer is told.
- **Attachments**: T3's CLI has no attachment flag; screenshots are saved in the project and
  referenced by path. The agent must be able to read images from disk.
- **Project discovery**: T3 has no `project list` CLI command; the bridge config names the T3
  project path or id. Thread listing is per project.
- **Source-change attribution** is a timing heuristic: any file change in the app root while a
  request is active (or ≤120 s after it completes) is attributed to that request, including your own edits.
- **Refresh observation** wraps a private dev-only React Native global (`__ReactRefresh`); compile
  errors are detected from Metro's thrown error messages via `ErrorUtils`. Both may change between
  RN versions; when unavailable the step shows "not observable" rather than claiming success.
- **Selection** cannot reach native modals or separate native windows; `zIndex` reordering is
  only respected by the native/DOM strategies; nested `<Text>` spans select the outer paragraph.
- **Private APIs**: see [component-inspection.md](component-inspection.md#private-apis-we-rely-on-all-isolated-in-srcinspectionfiberts-and-hit-testts).
- **Expo Go**: works only with typed input (no `expo-speech-recognition` / `react-native-view-shot`
  native modules) and requires the Babel plugin; use a development build.
- **Old Architecture** (Paper) is not supported for native hit testing; it falls back to geometry.
- **Windows Android builds** of any RN 0.88 app with codegen libraries can exceed the 260-character
  path limit in ninja; see [setup troubleshooting](setup.md#troubleshooting).
- **Console logs**: on RN 0.88 `console.log` from the app is not shown in Metro's terminal, so the
  inspector's `debug` prop is mostly useful with React Native DevTools.

## Remaining work (by importance)

1. Validate on a physical iPhone, on-device `en-AU` dictation with an installed model, and `--lan`.
   Re-run the physical Android flow with the issue #1 fixes (pair sheet link check, `pair-code`,
   online-recognition opt-in).
2. iOS build verification (config plugin output, local-network prompt, `findNodeAtPoint` on iOS).
3. React Native component tests (render the overlay with a mocked bridge client).
4. A T3 WebSocket/RPC adapter (when T3 documents it) for steering, attachments and push status
   instead of polling.
5. Per-request change attribution using the agent's own report of edited files, when T3 exposes it.
