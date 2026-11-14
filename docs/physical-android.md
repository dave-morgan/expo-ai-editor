# Physical Android over USB

Verified on a Pixel 6 (Android 16) over USB with a real Expo SDK 58 app. Each failure below cost
real debugging time; most look the same from the app ("Pairing failed", "Unable to load script"),
so check them in this order.

## The setup that works

The phone reaches both Metro and the bridge through `adb reverse`, so the bridge stays on
`127.0.0.1` (no `--lan`, nothing exposed to the network).

```sh
adb devices                          # exactly one device listed as "device"
adb reverse tcp:8081 tcp:8081        # Metro (phone port : computer port)
adb reverse tcp:8790 tcp:8790        # expo-ai-bridge
adb reverse --list                   # check both are there
npx expo start --dev-client          # Metro
npx expo-ai-bridge start             # bridge, prints the pairing code
```

`adb reverse` is lost when the cable is unplugged, the phone reboots or `adb` restarts: run both
commands again.

## Test the link first

Open the inspector. The pair sheet checks the URL in the **Bridge URL** field as you type
(`GET /health`) and shows what it reached:

| Pair sheet says                                               | Meaning                                                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `Reached expo-ai-bridge 0.1.0 at http://127.0.0.1:8790`       | Link is fine; enter the code                                                         |
| `Cannot reach http://…`                                       | Nothing answered: bridge not running, wrong port, or `adb reverse` missing or broken |
| `Something answered at http://… but it is not expo-ai-bridge` | A **proxy** or another server answered: see below                                    |

Without the app: open `http://127.0.0.1:8790/health` in the phone's browser. Expected:
`{"ok":true,"name":"expo-ai-bridge",…}`.

## Phone-wide HTTP proxy

Symptom: pairing fails with a bare `HTTP 404` (or "not expo-ai-bridge"), and the **bridge never
logs a request**.

Some tools (traffic inspectors, test harnesses) set a global proxy on the device. Every `fetch`
from the app then goes to the proxy, which answers `/pair` itself.

```sh
adb shell settings get global http_proxy        # anything other than null or :0 is a proxy
adb shell settings put global http_proxy :0     # remove it
```

## Metro is not on 8081

If something else uses 8081 on your computer, run Metro on another port and map the phone's 8081
to it:

```sh
npx expo start --dev-client --port 8197
adb reverse tcp:8081 tcp:8197
```

The bridge URL does not change: the inspector derives the **host** from the bundle URL and always
uses the bridge port (8790 unless you set `bridgePort`).

## "Unable to load script" / dev client points somewhere else

The dev client remembers the bundler host it last used, and it may not be `localhost:8081` (one
phone had `127.0.0.1:8888` saved). Check the dev menu (shake, or `adb shell input keyevent 82`) →
**Settings** → debug server host, or the dev-client launcher's server list. Either set it to
`localhost:8081`, or `adb reverse` the port it names: `adb reverse tcp:8888 tcp:8081`.

## `adb reverse` set up but no traffic

Rare, but seen: `adb reverse --list` shows the mapping, yet nothing arrives (the pair sheet says
`Cannot reach`). Try another USB port or cable, then `adb kill-server && adb start-server` and set
up both reverses again. The pair sheet's link check shows the result within a second.

## Pairing code expired

Codes last 10 minutes; device setup often takes longer. The bridge prints a new code when the old
one expires. To get one immediately:

- press `p` in the bridge terminal, or
- from any other terminal: `npx expo-ai-bridge pair-code` (talks to the running bridge on this
  machine only).

## Dictation: "Failed to download offline model … error: 5"

On Android the inspector uses on-device recognition by default, which needs the language's
offline model. If the download fails (seen on Android 16 for `en-AU`):

- typing always works;
- install the model from **Settings › System › Languages › On-device speech recognition**
  (wording varies by vendor), then tap the mic again;
- or tap **Use online recognition** in the panel: for this session only, audio goes to the
  phone's speech service (e.g. Google). It is never enabled without that tap. To allow it
  permanently, pass `requireOnDeviceRecognition={false}` to `<AIInspector />`.
