# Setup

## Requirements

|              | Supported / tested                                                                                                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Expo SDK     | 58 (tested). Should work on SDK 54+ with the New Architecture                                                                                                                                      |
| React Native | 0.88.1 (tested), New Architecture (Fabric) required for native hit testing                                                                                                                         |
| React        | 19.3                                                                                                                                                                                               |
| Node.js      | 20.19+ (tested on 24/26)                                                                                                                                                                           |
| T3 Code      | 0.1.9 desktop app with the `t3` CLI (tested)                                                                                                                                                       |
| Speech       | `expo-speech-recognition` 58.x: iOS 17+ (on-device needs a supported locale), Android 13+ for on-device                                                                                            |
| Build        | Expo **development build** (`expo-dev-client`). Expo Go does not include `expo-speech-recognition` or `react-native-view-shot`; in Expo Go the inspector works with typed input and no screenshots |

## 1. Install into your Expo app

Adding it to an app you already have? Follow the full checklist in
[Add to an existing app](existing-app.md) (install sources, peer dependencies, Babel order,
Metro `withExpoAI`, mount point).

Configure [GitHub Packages authentication or Release tarball dependencies](existing-app.md#1-install) first.

```sh
npx expo install @dave-morgan/expo-ai-inspector expo-speech-recognition react-native-view-shot expo-secure-store expo-dev-client
```

Only `@dave-morgan/expo-ai-inspector` is required; the others enable dictation, screenshots and remembered pairing.

`app.json`:

```json
{ "expo": { "plugins": ["@dave-morgan/expo-ai-inspector"] } }
```

The config plugin adds microphone / speech-recognition permission strings (through
`expo-speech-recognition`'s plugin) and an iOS local-network description. Options:
`microphonePermission`, `speechRecognitionPermission`, `localNetworkPermission`, `speech: false`.

`babel.config.js`:

```js
module.exports = function (api) {
  api.cache(true);
  return { presets: ["babel-preset-expo"], plugins: ["@dave-morgan/expo-ai-inspector/babel"] };
};
```

Root layout (expo-router) or `App.tsx`:

```tsx
import { AIInspector } from "@dave-morgan/expo-ai-inspector";

export default function RootLayout() {
  return (
    <>
      <Stack />
      {__DEV__ && <AIInspector />}
    </>
  );
}
```

Props: `projectId` (default: your Expo `slug`), `bridgeUrl` (default: Metro host + port 8790),
`bridgePort`, `locale` (default `en-AU`), `requireOnDeviceRecognition` (default `true`),
`defaultSettings` (`{ screenshots, autoSubmit, mode }`), `indicatorTopInset` (override the top of the indicator touch target, in points).

Rebuild the development client once (native modules changed), then clear Metro's cache:

```sh
npx expo run:ios   # or run:android, or an EAS development build
npx expo start --dev-client -c
```

## 2. Configure and start the bridge

`expo-ai-bridge.config.json` (in the directory you start the bridge from):

```json
{
  "host": "127.0.0.1",
  "port": 8790,
  "projects": [{ "id": "my-app", "name": "My app", "root": ".", "t3Project": "." }]
}
```

`id` must equal the inspector's `projectId` (your `slug` by default). `t3Project` is the T3 project
path or id; it may be a parent folder (monorepos): the prompt then tells the agent the app root.

```sh
npx expo-ai-bridge doctor   # checks T3 CLI, server and threads
npx expo-ai-bridge start    # prints URL and a 6-digit pairing code
```

Physical devices on Wi-Fi need the bridge on your LAN: `npx expo-ai-bridge start --lan`
(binds `0.0.0.0`; pairing is still required). Simulators and `adb reverse` work with the default
`127.0.0.1`:

```sh
adb reverse tcp:8790 tcp:8790   # Android emulator / USB device
```

Physical Android over USB: see [Physical Android over USB](physical-android.md).

Running the app from a git worktree (for example a T3 Code worktree)? The bridge maps a
worktree `t3Project` path to the main checkout, which is the path T3 Code knows.

## 3. Pair the device

Open the app, pull down from the thin indicator line below the status bar. The panel shows **Pair**: the bridge URL is pre-filled from the
Metro host; type the 6-digit code from the bridge terminal. The session token is stored in the
keychain (with `expo-secure-store`) for 12 hours.

Before pairing, the sheet checks the URL (`GET /health`) and says what it reached: the bridge,
nothing, or something that is not the bridge (a proxy, a wrong port). Codes last 10 minutes; the
bridge prints a fresh one when a code expires. For one immediately, press `p` in the bridge
terminal or run `npx expo-ai-bridge pair-code` in another terminal.

## 4. Use it

1. Tap the thin top indicator to enable selection. Tap an app element to outline it.
2. Hold the indicator to dictate: it turns cyan and pulses while listening. Release to stop.
3. Review the transcript in the panel, edit if needed, and choose **Send to agent**.
4. Tap the indicator again to disable selection and use the app normally. Your draft and selection are kept.
5. Pull down from the indicator whenever you need pairing, thread selection, typing, settings, or history.

The indicator is a 4-point line with a centered 112-by-44-point touch target; it does not cover
corner navigation buttons. Gray means selection off; violet means selection on; cyan means
listening, amber means disconnected or working, green means refresh observed, and red means an
error (open controls for details). Screen readers expose toggle, dictation, and controls actions.
Reduced motion keeps the recording color steady. The indicator sits below the status bar;
set `indicatorTopInset` if your host layout needs a different position.

Selecting an element leaves the panel closed. While selection is enabled, app taps select
rather than activate controls. Disable selection to scroll or interact normally. Voice input
opens the panel for review; the existing **Auto-submit** setting can explicitly opt into sending
final transcripts immediately. Holding an inactive indicator neither enables selection nor records.

## Running the example app

```sh
npx -y pnpm@10.34.9 install
npx -y pnpm@10.34.9 build
cd apps/example-expo
npx expo prebuild && npx expo run:android      # or run:ios (macOS)
# new terminal, repo root:
node packages/expo-ai-bridge/dist/cli.js start --config expo-ai-bridge.config.json
adb reverse tcp:8790 tcp:8790                  # Android
```

The example config targets T3 project `.` (the repository root). Add it in T3 Code
(`t3 project add .`) and open a thread there before pairing.

On a physical iPhone: build with `npx expo run:ios --device` (or EAS development build), start the
bridge with `--lan`, keep phone and computer on the same network, and allow the local-network
prompt.

## Troubleshooting

| Symptom                                                              | Fix                                                                                                                                                                                                  |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Source location unavailable" / confidence none                      | Add `@dave-morgan/expo-ai-inspector/babel` to Babel plugins and restart Metro with `-c`                                                                                                              |
| Pairing: "Cannot reach"                                              | Phone and computer on same network; bridge started with `--lan`; firewall allows TCP 8790; or `adb reverse tcp:8790 tcp:8790`. USB details: [physical-android.md](physical-android.md)               |
| Pairing: "not expo-ai-bridge" / bare `HTTP 404`, bridge logs nothing | A device-wide HTTP proxy or another server answered: `adb shell settings get global http_proxy`; see [physical-android.md](physical-android.md#phone-wide-http-proxy)                                |
| Pairing: "wrong or expired"                                          | Codes last 10 minutes; press `p` in the bridge or run `npx expo-ai-bridge pair-code`                                                                                                                 |
| "Choose a T3 thread" with an empty list                              | Add the project in T3 Code and start a thread; check `expo-ai-bridge doctor` (it prints the T3 project path it uses, after worktree mapping)                                                         |
| Status stuck at "Queued … retrying"                                  | T3 Code is not running; start the desktop app or `t3 serve`                                                                                                                                          |
| Mic disabled with "On-device speech recognition is not supported"    | Device lacks on-device recognition for the locale; type instead, download the model (Android 13+ button), tap **Use online recognition** (this session), or set `requireOnDeviceRecognition={false}` |
| "on-device model could not be downloaded (Android error 5)"          | Install the model in Android Settings, or use online recognition; see [physical-android.md](physical-android.md#dictation-failed-to-download-offline-model--error-5)                                 |
| "Unable to load script" on a USB phone                               | Dev client points at another bundler host/port; `adb reverse` that port. See [physical-android.md](physical-android.md)                                                                              |
| "Native rebuild required"                                            | The agent changed `app.json`, `package.json` or native folders; rebuild the dev client                                                                                                               |
| Windows Android build: `Filename longer than 260 characters` (ninja) | Build from a short path: `subst R: C:\path\to\repo`, then build in `R:\apps\example-expo\android` (optionally `-PreactNativeArchitectures=x86_64` for the emulator)                                  |
| Gradle stalls downloading a Build-Tools version                      | Add `android.buildToolsVersion=<installed version>` to `android/gradle.properties`                                                                                                                   |
| Selection hits the wrong view inside a Modal                         | Native modals are separate windows; see [limitations](./limitations.md)                                                                                                                              |
