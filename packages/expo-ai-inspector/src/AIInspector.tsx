import { createRequestId, type DeliveryMode, type DeviceInfo, type ServerMessage, type ThreadSummary } from "@dave-morgan/expo-ai-protocol";
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  Dimensions,
  Keyboard,
  NativeModules,
  PixelRatio,
  Platform,
  StyleSheet,
  Text,
  View,
  Pressable,
  useWindowDimensions,
  type GestureResponderEvent,
} from "react-native";
import { BridgeClient, probeBridge, type ConnectionState } from "./bridge/client";
import { discoverBridgeUrl } from "./bridge/discovery";
import { buildSelection } from "./inspection/metadata";
import { hitTest } from "./inspection/hit-test";
import { optional } from "./platform/optional";
import { observeRefresh } from "./platform/refresh-observer";
import { captureAppScreenshot, screenshotsSupported } from "./platform/screenshot";
import { useSpeechInput } from "./platform/speech";
import { createTokenStore } from "./platform/token-store";
import { createInitialState, inspectorReducer, type InspectorSettings } from "./state/inspector-state";
import { Highlight } from "./ui/Highlight";
import { Panel, type PanelController } from "./ui/Panel";
import { colors, shadow, space } from "./ui/theme";

export const INSPECTOR_VERSION = "0.1.0";
const OVERLAY_NATIVE_ID = "expo-ai-inspector-overlay";

export interface AIInspectorProps {
  /** Bridge base URL, e.g. `http://192.168.1.20:8790`. Default: Metro host + `bridgePort`. */
  bridgeUrl?: string;
  bridgePort?: number;
  /** Must match a project id registered in the bridge config. Default: Expo `slug`. */
  projectId?: string;
  /** Speech locale. Default `en-AU`. */
  locale?: string;
  /** Refuse network speech recognition (default true). When unavailable, typed input is offered. */
  requireOnDeviceRecognition?: boolean;
  /** Initial settings (the developer can change them in the panel). */
  defaultSettings?: Partial<InspectorSettings>;
  /** Where the floating button sits. */
  buttonPosition?: "bottom-right" | "bottom-left" | "top-right" | "top-left";
  /** Log selections and bridge status to the Metro console. */
  debug?: boolean;
  /** Opt in to rendering outside `__DEV__`. Never enable this in store builds. */
  dangerouslyEnableInProduction?: boolean;
}

declare const __DEV__: boolean;

/**
 * Development-only inspector overlay. Renders nothing in production builds unless explicitly
 * forced; combine with `{__DEV__ && <AIInspector />}` so bundlers can drop it entirely.
 */
export function AIInspector(props: AIInspectorProps) {
  const isDev = typeof __DEV__ !== "undefined" && __DEV__;
  if (!isDev && !props.dangerouslyEnableInProduction) return null;
  return <InspectorRoot {...props} />;
}

const Constants = optional.constants();
const routerModule = optional.router();

function usePathnameSafe(): string | undefined {
  const usePathname = routerModule?.usePathname;
  try {
    // Always called (or never) for the lifetime of the module, so hook order is stable.
    return usePathname ? usePathname() : undefined;
  } catch {
    return undefined;
  }
}

function resolveProjectId(explicit?: string): string {
  if (explicit) return explicit;
  const slug = Constants?.expoConfig?.slug;
  return typeof slug === "string" && slug ? slug : "expo-app";
}

function resolveBridgeUrl(explicit: string | undefined, port: number | undefined): string | null {
  if (explicit) return explicit;
  let scriptURL: string | null;
  try {
    scriptURL = NativeModules?.SourceCode?.getConstants?.().scriptURL ?? NativeModules?.SourceCode?.scriptURL ?? null;
  } catch {
    scriptURL = null;
  }
  const webHostname = Platform.OS === "web" ? (globalThis as { location?: { hostname?: string } }).location?.hostname : null;
  return discoverBridgeUrl({
    hostUri: Constants?.expoConfig?.hostUri ?? Constants?.expoGoConfig?.debuggerHost ?? null,
    scriptURL,
    webHostname: webHostname ?? null,
    ...(port ? { port } : {}),
  });
}

function deviceInfo(): DeviceInfo {
  const window = Dimensions.get("window");
  const platform = Platform.OS === "ios" || Platform.OS === "android" || Platform.OS === "web" ? Platform.OS : "other";
  return {
    platform,
    osVersion: String(Platform.Version ?? ""),
    ...(Constants?.deviceName ? { deviceName: String(Constants.deviceName).slice(0, 128) } : {}),
    windowWidth: window.width,
    windowHeight: window.height,
    pixelRatio: PixelRatio.get(),
  };
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

function InspectorRoot(props: AIInspectorProps) {
  const locale = props.locale ?? "en-AU";
  const requireOnDevice = props.requireOnDeviceRecognition ?? true;
  const projectId = resolveProjectId(props.projectId);
  const window = useWindowDimensions();
  const screen = usePathnameSafe();
  const overlayRef = useRef<React.ComponentRef<typeof View>>(null);
  const [state, dispatch] = useReducer(inspectorReducer, props.defaultSettings, createInitialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  const [bridgeUrl, setBridgeUrl] = useState(() => resolveBridgeUrl(props.bridgeUrl, props.bridgePort));
  const [connection, setConnection] = useState<ConnectionState>({ status: "idle" });
  const [threads, setThreads] = useState<{ threads: ThreadSummary[]; selectedThreadId: string | null; error?: string }>({
    threads: [],
    selectedThreadId: null,
  });
  const [hiddenForCapture, setHiddenForCapture] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [refreshSupported, setRefreshSupported] = useState(false);
  const tokenStore = useMemo(() => createTokenStore(), []);
  const lastThreadRef = useRef<string | null>(null);
  const clientId = useMemo(() => `insp-${createRequestId().slice(0, 13)}`, []);

  const client = useMemo(() => {
    if (!bridgeUrl) return null;
    return new BridgeClient({
      bridgeUrl,
      projectId,
      clientId,
      device: deviceInfo(),
      inspectorVersion: INSPECTOR_VERSION,
      tokenStore,
    });
  }, [bridgeUrl, projectId, clientId, tokenStore]);

  useEffect(() => {
    if (!client) {
      setConnection({ status: "unpaired", reason: "Bridge URL could not be detected; enter it below." });
      return;
    }
    const offState = client.on("state", setConnection);
    const offThreads = client.on("threads", (next) => {
      // The bridge keeps the thread choice in memory; restore ours after a bridge restart.
      const remembered = lastThreadRef.current;
      if (!next.selectedThreadId && remembered && next.threads.some((t) => t.threadId === remembered)) {
        client.send({ type: "threads.select", threadId: remembered });
      }
      if (next.selectedThreadId) lastThreadRef.current = next.selectedThreadId;
      setThreads(next);
    });
    const offMessage = client.on("message", (message: ServerMessage) => {
      if (props.debug && message.type === "request.status") console.log(`[expo-ai-inspector] ${message.requestId} ${message.phase}${message.detail ? `: ${message.detail}` : ""}`);
      dispatch({ type: "server", message, now: Date.now() });
    });
    void client.start();
    return () => {
      offState();
      offThreads();
      offMessage();
      client.stop();
    };
  }, [client, props.debug]);

  // Report Fast Refresh / compile errors for requests whose files changed.
  useEffect(() => {
    const { supported, unsubscribe } = observeRefresh((event) => {
      const current = stateRef.current;
      const active = current.activeRequestId ? current.requests[current.activeRequestId] : undefined;
      if (!active || !active.seen.submitted) return;
      client?.send({ type: "refresh.event", kind: event.kind, at: new Date().toISOString(), ...(event.message ? { message: event.message } : {}) });
    });
    setRefreshSupported(supported);
    return unsubscribe;
  }, [client]);

  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow", (e) => setKeyboardHeight(e.endCoordinates.height));
    const hide = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide", () => setKeyboardHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  // --- submission -----------------------------------------------------------------------------
  const sendRequest = useCallback(
    async (instruction: string, inputMethod: "voice" | "typed" | "voice-edited", reuseId?: string) => {
      const current = stateRef.current;
      const text = instruction.trim();
      if (!text) {
        dispatch({ type: "error", message: "Say or type an instruction first." });
        return;
      }
      if (!client) {
        dispatch({ type: "error", message: "Not connected to a bridge." });
        return;
      }
      const threadId = threads.selectedThreadId;
      if (!threadId) {
        dispatch({ type: "error", message: "Choose a T3 thread first." });
        dispatch({ type: "setView", view: "threads" });
        return;
      }
      const selection = current.selection ?? undefined;
      const requestId = reuseId ?? createRequestId();
      let screenshot = undefined as Awaited<ReturnType<typeof captureAppScreenshot>> | undefined;
      const accepts = connection.status !== "connected" || connection.screenshotsAccepted;
      if (current.settings.screenshots && accepts && screenshotsSupported()) {
        try {
          Keyboard.dismiss();
          setHiddenForCapture(true);
          await nextFrame();
          await nextFrame();
          screenshot = (await captureAppScreenshot(Dimensions.get("window"))) ?? undefined;
        } catch {
          screenshot = undefined; // screenshots are best effort
        } finally {
          setHiddenForCapture(false);
        }
      }
      dispatch({
        type: "submitted",
        request: {
          requestId,
          instruction: text,
          ...(selection?.componentName ? { componentName: selection.componentName } : {}),
          ...(selection?.source ? { sourceLabel: `${selection.source.file}:${selection.source.line}` } : {}),
          threadId,
          createdAt: Date.now(),
          payload: { instruction: text, ...(selection ? { selection } : {}), inputMethod },
        },
      });
      try {
        client.submit({
          requestId,
          projectId,
          threadId,
          instruction: text,
          inputMethod,
          mode: current.settings.mode as DeliveryMode,
          ...(selection ? { selection } : {}),
          ...(screenshot ? { screenshot } : {}),
          createdAt: new Date().toISOString(),
        });
      } catch (error) {
        dispatch({ type: "error", message: `Could not send: ${(error as Error).message}` });
      }
    },
    [client, connection, projectId, threads.selectedThreadId],
  );

  const autoSubmitRef = useRef(false);
  const speech = useSpeechInput(
    {
      locale,
      requireOnDevice,
      onFinal: (transcript) => {
        dispatch({ type: "appendVoice", text: transcript });
        if (stateRef.current.settings.autoSubmit) autoSubmitRef.current = true;
      },
    },
    Platform.OS,
  );

  useEffect(() => {
    if (autoSubmitRef.current && state.transcript.trim()) {
      autoSubmitRef.current = false;
      void sendRequest(state.transcript, state.inputMethod === "typed" ? "voice" : state.inputMethod);
    }
  }, [state.transcript, state.inputMethod, sendRequest]);

  // --- selection --------------------------------------------------------------------------------
  const pttActive = useRef(false);
  const selectAt = useCallback(
    async (x: number, y: number) => {
      dispatch({ type: "hitTestStarted" });
      try {
        const hit = await hitTest(overlayRef.current, x, y);
        if (!hit) {
          dispatch({ type: "selectionFailed", message: "Nothing selectable at that point." });
          return false;
        }
        const selection = buildSelection({
          host: hit.fiber,
          bounds: hit.bounds,
          ...(screen ? { screen } : {}),
          ...(hit.overlappingCandidates !== undefined ? { overlappingCandidates: hit.overlappingCandidates } : {}),
          flattenStyle: StyleSheet.flatten as (style: unknown) => unknown,
          hitTestStrategy: hit.strategy,
        });
        if (props.debug) console.log(`[expo-ai-inspector] selected via ${hit.strategy}: ${JSON.stringify(selection)}`);
        dispatch({ type: "selected", selection });
        return true;
      } catch (error) {
        dispatch({ type: "selectionFailed", message: `Selection failed: ${(error as Error).message}` });
        return false;
      }
    },
    [screen, props.debug],
  );

  const pressStart = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> | null; long: boolean } | null>(null);
  const onCatcherGrant = (event: GestureResponderEvent) => {
    const { pageX, pageY } = event.nativeEvent;
    const entry = { x: pageX, y: pageY, timer: null as ReturnType<typeof setTimeout> | null, long: false };
    entry.timer = setTimeout(async () => {
      entry.long = true;
      // Long-press: select and start press-to-talk dictation until release.
      if (await selectAt(entry.x, entry.y)) {
        if (pressStart.current === entry && speech.support?.ok !== false) {
          pttActive.current = true;
          void speech.start();
        }
      }
    }, 450);
    pressStart.current = entry;
  };
  const onCatcherRelease = () => {
    const entry = pressStart.current;
    pressStart.current = null;
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.long) {
      if (pttActive.current) {
        pttActive.current = false;
        speech.stop();
      }
      return;
    }
    void selectAt(entry.x, entry.y);
  };

  // --- controller for the panel -----------------------------------------------------------------
  const controller: PanelController = {
    state,
    connection,
    bridgeUrl,
    projectId,
    threads: threads.threads,
    selectedThreadId: threads.selectedThreadId,
    ...(threads.error ? { threadsError: threads.error } : {}),
    speech: {
      status: speech.status,
      partial: speech.partial,
      error: speech.error,
      support: speech.support,
      locale,
      onDevice: speech.onDevice,
      onlineAvailable: speech.onlineAvailable,
    },
    screenshotsAvailable: screenshotsSupported(),
    refreshSupported,
    close: () => {
      speech.cancel();
      dispatch({ type: "close" });
    },
    reselect: () => dispatch({ type: "startSelecting" }),
    clearSelection: () => dispatch({ type: "clearSelection" }),
    setTranscript: (text) => dispatch({ type: "setTranscript", text, edited: true }),
    toggleMic: () => {
      if (speech.status === "listening" || speech.status === "starting") speech.stop();
      else void speech.start();
    },
    micPressIn: () => {
      pttActive.current = true;
      void speech.start();
    },
    micPressOut: () => {
      if (pttActive.current) {
        pttActive.current = false;
        speech.stop();
      }
    },
    submit: () => void sendRequest(state.transcript, state.inputMethod),
    cancelRequest: (id) => {
      client?.send({ type: "feedback.cancel", requestId: id });
      dispatch({ type: "cancelLocal", requestId: id });
    },
    retryRequest: (id) => {
      const request = state.requests[id];
      if (request) void sendRequest(request.payload.instruction, request.payload.inputMethod);
    },
    dismissRequest: () => dispatch({ type: "dismissRequest" }),
    setView: (view) => {
      dispatch({ type: "setView", view });
      if (view === "threads") client?.send({ type: "threads.list" });
    },
    selectThread: (id) => {
      client?.send({ type: "threads.select", threadId: id });
      dispatch({ type: "setView", view: "main" });
    },
    refreshThreads: () => client?.send({ type: "threads.list" }),
    setSetting: (key, value) => dispatch({ type: "setSetting", key, value }),
    pair: async (url, code) => {
      const normalized = url.replace(/\/$/, "");
      if (normalized !== bridgeUrl) {
        // Pair through a temporary client, then switch URL: the new client finds the stored token.
        const temp = new BridgeClient({ bridgeUrl: normalized, projectId, clientId, device: deviceInfo(), tokenStore });
        await temp.pair(code, deviceInfo().deviceName);
        temp.stop();
        setBridgeUrl(normalized);
        return;
      }
      if (!client) throw new Error("Enter the bridge URL.");
      await client.pair(code, deviceInfo().deviceName);
    },
    unpair: () => void client?.unpair(),
    reconnect: () => void client?.reconnect(),
    downloadSpeechModel: () => void speech.downloadModel(),
    allowOnlineSpeech: speech.allowOnline,
    // Stable reference: the pair sheet re-probes when this changes.
    probeBridge,
  };

  const selection = state.selection;
  const showHighlight = selection && state.mode !== "closed";
  const buttonPos = props.buttonPosition ?? "bottom-right";

  return (
    <View
      ref={overlayRef}
      nativeID={OVERLAY_NATIVE_ID}
      collapsable={false}
      pointerEvents="box-none"
      style={[StyleSheet.absoluteFill, hiddenForCapture && styles.hidden]}
    >
      {state.mode === "selecting" ? (
        <View
          style={[StyleSheet.absoluteFill, styles.catcher]}
          onStartShouldSetResponder={() => true}
          onMoveShouldSetResponder={() => true}
          onResponderTerminationRequest={() => false}
          onResponderGrant={onCatcherGrant}
          onResponderRelease={onCatcherRelease}
          onResponderTerminate={() => {
            if (pressStart.current?.timer) clearTimeout(pressStart.current.timer);
            pressStart.current = null;
          }}
          accessibilityLabel="Inspector selection layer. Tap an element to select it."
        />
      ) : null}

      {showHighlight ? (
        <Highlight
          bounds={selection.bounds}
          title={selection.componentName ? `${selection.componentName} › ${selection.elementType}` : selection.elementType}
          {...(selection.source ? { subtitle: `${selection.source.file.split("/").pop()}:${selection.source.line}` } : {})}
          window={window}
        />
      ) : null}

      {state.mode === "selecting" ? (
        <View pointerEvents="box-none" style={[styles.banner, shadow]}>
          <Text style={styles.bannerText}>{state.selecting ? "Inspecting…" : "Tap an element · hold to select and dictate"}</Text>
          <Pressable
            onPress={() => (selection ? dispatch({ type: "selected", selection }) : dispatch({ type: "close" }))}
            accessibilityRole="button"
            accessibilityLabel="Stop selecting"
            hitSlop={10}
          >
            <Text style={styles.bannerAction}>{selection ? "Done" : "Cancel"}</Text>
          </Pressable>
        </View>
      ) : null}
      {state.mode === "selecting" && state.error ? (
        <View pointerEvents="none" style={styles.toast}>
          <Text style={styles.toastText}>{state.error}</Text>
        </View>
      ) : null}

      {state.mode === "panel" ? <Panel c={controller} bottomInset={keyboardHeight > 0 ? keyboardHeight : space.lg} /> : null}

      {state.mode === "closed" ? (
        <Pressable
          onPress={() => dispatch({ type: "open" })}
          onLongPress={() => dispatch({ type: "startSelecting" })}
          accessibilityRole="button"
          accessibilityLabel="Open AI inspector"
          accessibilityHint="Long-press to start selecting immediately"
          style={({ pressed }) => [styles.fab, fabPosition(buttonPos), shadow, pressed && { transform: [{ scale: 0.94 }] }]}
        >
          <View style={styles.fabRing}>
            <View style={styles.fabDot} />
          </View>
          {connection.status !== "connected" ? <View style={[styles.fabBadge, { backgroundColor: connection.status === "unpaired" ? colors.textFaint : colors.warning }]} /> : null}
        </Pressable>
      ) : null}
    </View>
  );
}

function fabPosition(position: NonNullable<AIInspectorProps["buttonPosition"]>) {
  const vertical = position.startsWith("top") ? { top: 64 } : { bottom: 96 };
  const horizontal = position.endsWith("left") ? { left: 16 } : { right: 16 };
  return { ...vertical, ...horizontal };
}

const styles = StyleSheet.create({
  hidden: { opacity: 0 },
  catcher: { backgroundColor: colors.scrim },
  banner: {
    position: "absolute",
    top: 56,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm + 2,
    borderRadius: 999,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
  },
  bannerText: { color: colors.text, fontSize: 13, fontWeight: "500" },
  bannerAction: { color: "#B9AFFF", fontSize: 13, fontWeight: "700" },
  toast: {
    position: "absolute",
    bottom: 120,
    alignSelf: "center",
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: 999,
    backgroundColor: colors.dangerSoft,
  },
  toastText: { color: colors.danger, fontSize: 13, fontWeight: "600" },
  fab: {
    position: "absolute",
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  fabRing: { width: 22, height: 22, borderRadius: 11, borderWidth: 2.5, borderColor: "#fff", alignItems: "center", justifyContent: "center" },
  fabDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#fff" },
  fabBadge: { position: "absolute", top: 3, right: 3, width: 12, height: 12, borderRadius: 6, borderWidth: 2, borderColor: colors.accent },
});
