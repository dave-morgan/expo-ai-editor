import type { DeliveryMode, Selection, ThreadSummary } from "@dave-morgan/expo-ai-protocol";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import type { BridgeProbe, ConnectionState } from "../bridge/client";
import type { SpeechStatus, SpeechSupport } from "../platform/speech";
import {
  canCancel,
  canRetry,
  formatElapsed,
  requestLifecycle,
  requestOutcome,
  type InspectorState,
  type LifecycleStage,
  type StageState,
  type TrackedRequest,
} from "../state/inspector-state";
import { IconButton } from "./primitives";
import { DEFAULT_DETENT, detentHeight, dragHeight, settle, stepDetent, type Detent } from "./sheet";
import { colors, mono, radius, space, type } from "./theme";

export interface PanelController {
  state: InspectorState;
  connection: ConnectionState;
  bridgeUrl: string | null;
  projectId: string;
  threads: ThreadSummary[];
  selectedThreadId: string | null;
  threadsError?: string;
  speech: {
    status: SpeechStatus;
    partial: string;
    error: string | null;
    support: SpeechSupport | null;
    locale: string;
    /** False once the user opted in to online recognition for this session. */
    onDevice: boolean;
    /** Only the on-device requirement blocks dictation; offer the explicit online opt-in. */
    onlineAvailable: boolean;
  };
  screenshotsAvailable: boolean;
  refreshSupported: boolean;
  close(): void;
  reselect(): void;
  clearSelection(): void;
  setTranscript(text: string): void;
  toggleMic(): void;
  micPressIn(): void;
  micPressOut(): void;
  submit(): void;
  cancelRequest(id: string): void;
  retryRequest(id: string): void;
  dismissRequest(): void;
  setView(view: InspectorState["view"]): void;
  selectThread(id: string): void;
  refreshThreads(): void;
  setSetting<K extends keyof InspectorState["settings"]>(key: K, value: InspectorState["settings"][K]): void;
  pair(url: string, code: string): Promise<void>;
  unpair(): void;
  reconnect(): void;
  downloadSpeechModel(): void;
  allowOnlineSpeech(): void;
  /** GET /health on a candidate bridge URL, so the pair sheet can say what it actually reached. */
  probeBridge(url: string): Promise<BridgeProbe>;
}

export function connectionSummary(connection: ConnectionState): { label: string; color: string } {
  switch (connection.status) {
    case "connected":
      return { label: "Connected", color: colors.success };
    case "connecting":
      return { label: "Connecting…", color: colors.warning };
    case "disconnected":
      return { label: `Reconnecting in ${Math.ceil(connection.retryInMs / 1000)}s`, color: colors.warning };
    case "unpaired":
      return { label: "Not paired", color: colors.textFaint };
    case "failed":
      return { label: "Connection failed", color: colors.danger };
    default:
      return { label: "Idle", color: colors.textFaint };
  }
}

const STAGE_TONE: Record<StageState, string> = {
  done: colors.success,
  active: colors.accent,
  waiting: colors.warning,
  failed: colors.danger,
  pending: colors.textFaint,
};

// --- sheet ---------------------------------------------------------------------------------------

/** Animated height with ¼ / ½ / ¾ detents. Only the top bar drags, so lists scroll normally. */
function useSheet(onDismiss: () => void) {
  const { height: windowHeight } = useWindowDimensions();
  const [detent, setDetent] = useState<Detent>(DEFAULT_DETENT);
  const height = useRef(new Animated.Value(detentHeight(DEFAULT_DETENT, windowHeight))).current;
  const live = useRef({ windowHeight, detent, start: 0, reduceMotion: false, onDismiss });
  live.current.windowHeight = windowHeight;
  live.current.detent = detent;
  live.current.onDismiss = onDismiss;

  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled?.().then((reduced) => {
      if (alive) live.current.reduceMotion = reduced;
    });
    return () => {
      alive = false;
    };
  }, []);

  const snapTo = (next: Detent) => {
    setDetent(next);
    const toValue = detentHeight(next, live.current.windowHeight);
    if (live.current.reduceMotion) height.setValue(toValue);
    else Animated.spring(height, { toValue, useNativeDriver: false, damping: 24, stiffness: 260, mass: 0.9 }).start();
  };

  // Rotation or split-screen: keep the same detent at the new size.
  useEffect(() => {
    height.setValue(detentHeight(detent, windowHeight));
  }, [windowHeight]);

  const responder = useMemo(
    () =>
      PanResponder.create({
        // Capture only clear vertical drags, so taps on the header's buttons still land.
        onMoveShouldSetPanResponderCapture: (_e, g) => Math.abs(g.dy) > 6 && Math.abs(g.dy) > Math.abs(g.dx),
        onPanResponderGrant: () => {
          height.stopAnimation((value) => {
            live.current.start = value;
          });
        },
        onPanResponderMove: (_e, g) => height.setValue(dragHeight(live.current.start, g.dy, live.current.windowHeight)),
        onPanResponderRelease: (_e, g) => {
          const current = dragHeight(live.current.start, g.dy, live.current.windowHeight);
          const target = settle(current, g.vy, live.current.windowHeight);
          if (target === "dismiss") live.current.onDismiss();
          else snapTo(target);
        },
        onPanResponderTerminate: () => snapTo(live.current.detent),
      }),
    [],
  );

  return { height, detent, snapTo, panHandlers: responder.panHandlers, windowHeight };
}

export function Panel({ c, bottomInset }: { c: PanelController; bottomInset: number }) {
  const sheet = useSheet(c.close);
  const view = c.connection.status === "unpaired" ? "pair" : c.state.view === "history" ? "main" : c.state.view;
  const sub = view === "settings" || view === "threads";

  return (
    <View style={[styles.sheet, { paddingBottom: bottomInset }]} accessibilityViewIsModal>
      <Animated.View style={{ height: sheet.height, maxHeight: sheet.windowHeight - bottomInset - 40 }}>
        <View {...sheet.panHandlers}>
          <Pressable
            onPress={() => sheet.snapTo(sheet.detent === 0.75 ? 0.5 : stepDetent(sheet.detent, 1))}
            accessibilityRole="adjustable"
            accessibilityLabel="Panel height"
            accessibilityValue={{ text: sheet.detent === 0.25 ? "quarter" : sheet.detent === 0.5 ? "half" : "three quarters" }}
            accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
            onAccessibilityAction={(e) => sheet.snapTo(stepDetent(sheet.detent, e.nativeEvent.actionName === "increment" ? 1 : -1))}
            hitSlop={{ top: 8, bottom: 4, left: 60, right: 60 }}
            style={styles.grabberZone}
          >
            <View style={styles.grabber} />
          </Pressable>
          {sub ? <SubHeader c={c} title={view === "threads" ? "Thread" : "Settings"} /> : <MainHeader c={c} paired={view !== "pair"} />}
        </View>
        {view === "pair" && <PairView c={c} />}
        {view === "threads" && <ThreadsView c={c} />}
        {view === "settings" && <MenuView c={c} />}
        {view === "main" && <MainView c={c} compact={sheet.detent === 0.25} />}
      </Animated.View>
    </View>
  );
}

function MainHeader({ c, paired }: { c: PanelController; paired: boolean }) {
  const conn = connectionSummary(c.connection);
  const thread = c.threads.find((t) => t.threadId === c.selectedThreadId);
  const connected = c.connection.status === "connected";
  const title = !paired ? "Pair with bridge" : connected ? (thread ? thread.title || thread.threadId : "Choose a thread") : conn.label;
  return (
    <View style={styles.header}>
      <Pressable
        style={({ pressed }) => [styles.headerTarget, pressed && paired && { opacity: 0.7 }]}
        onPress={() => paired && c.setView("threads")}
        disabled={!paired}
        accessibilityRole="button"
        accessibilityLabel={`T3 thread: ${title}. ${conn.label}`}
      >
        <View style={[styles.liveDot, { backgroundColor: conn.color }]} />
        <Text style={[styles.headerTitle, !thread && connected && { color: colors.warning }]} numberOfLines={1}>
          {title}
        </Text>
        {paired ? <Text style={styles.caret}>▾</Text> : null}
      </Pressable>
      {paired ? <IconButton glyph="⋯" label="Settings and connection" onPress={() => c.setView("settings")} size={34} /> : null}
      <IconButton glyph="✕" label="Close inspector" onPress={c.close} size={34} />
    </View>
  );
}

function SubHeader({ c, title }: { c: PanelController; title: string }) {
  return (
    <View style={styles.header}>
      <IconButton glyph="‹" label="Back" onPress={() => c.setView("main")} size={34} />
      <Text style={[styles.headerTitle, { flex: 1 }]} numberOfLines={1}>
        {title}
      </Text>
      <IconButton glyph="✕" label="Close inspector" onPress={c.close} size={34} />
    </View>
  );
}

// --- main ----------------------------------------------------------------------------------------

function MainView({ c, compact }: { c: PanelController; compact: boolean }) {
  const { state } = c;
  const active = state.activeRequestId ? state.requests[state.activeRequestId] : undefined;
  const earlier = state.history
    .filter((id) => id !== state.activeRequestId)
    .map((id) => state.requests[id])
    .filter((r): r is TrackedRequest => !!r);
  const offline = c.connection.status === "disconnected" || c.connection.status === "failed" || c.connection.status === "connecting";

  return (
    <View style={styles.main}>
      <SelectionStrip selection={state.selection} c={c} />
      {offline ? (
        <Notice tone={colors.warning} text={connectionSummary(c.connection).label} action={{ label: "Retry", onPress: c.reconnect }} />
      ) : null}
      <ScrollView style={styles.feed} contentContainerStyle={styles.feedContent} keyboardShouldPersistTaps="handled">
        {active ? compact ? <ActiveLine request={active} /> : <ActiveRequest request={active} c={c} /> : null}
        {earlier.length > 0 && !compact ? (
          <View style={{ marginTop: active ? space.lg : 0 }}>
            <Text style={styles.sectionLabel}>Earlier</Text>
            {earlier.map((request) => (
              <EarlierRow key={request.requestId} request={request} c={c} />
            ))}
          </View>
        ) : null}
        {!active && earlier.length === 0 ? (
          <Text style={styles.empty}>
            {state.selection ? "Describe the change below." : "Select an element, then describe the change."}
          </Text>
        ) : null}
      </ScrollView>
      <Composer c={c} />
    </View>
  );
}

function SelectionStrip({ selection, c }: { selection: Selection | null; c: PanelController }) {
  if (!selection) {
    return (
      <Pressable onPress={c.reselect} style={({ pressed }) => [styles.strip, pressed && styles.stripPressed]} accessibilityRole="button" accessibilityLabel="Select an element">
        <Text style={styles.stripGlyph}>⌖</Text>
        <Text style={[styles.stripText, { color: colors.textMuted }]}>Select an element</Text>
      </Pressable>
    );
  }
  const tone = selection.confidence === "high" ? colors.success : selection.confidence === "medium" ? colors.warning : colors.danger;
  const where = selection.source ? `${selection.source.file.split("/").pop()}:${selection.source.line}` : "no source";
  return (
    <View style={styles.strip}>
      <Pressable
        onPress={c.reselect}
        style={styles.stripMain}
        accessibilityRole="button"
        accessibilityLabel={`Selected ${selection.componentName ?? ""} ${selection.elementType}, ${where}, ${selection.confidence} confidence. Tap to reselect.`}
      >
        <View style={[styles.confDot, { backgroundColor: tone }]} />
        <Text style={styles.stripText} numberOfLines={1}>
          {selection.componentName ? <Text style={{ color: colors.textMuted }}>{selection.componentName} › </Text> : null}
          {selection.elementType}
        </Text>
        <Text style={styles.stripPath} numberOfLines={1} ellipsizeMode="head">
          {where}
        </Text>
      </Pressable>
      <IconButton glyph="✕" label="Clear selection" onPress={c.clearSelection} size={28} />
    </View>
  );
}

function ActiveRequest({ request, c }: { request: TrackedRequest; c: PanelController }) {
  const stages = requestLifecycle(request);
  return (
    <View accessibilityLiveRegion="polite">
      <View style={styles.requestHead}>
        <Text style={styles.instruction} numberOfLines={2}>
          {request.instruction}
        </Text>
        <View style={styles.inlineActions}>
          {canCancel(request) ? <TextAction label="Cancel" tone={colors.danger} onPress={() => c.cancelRequest(request.requestId)} /> : null}
          {canRetry(request) ? <TextAction label="Retry" onPress={() => c.retryRequest(request.requestId)} /> : null}
          <IconButton glyph="✕" label="Dismiss request" onPress={c.dismissRequest} size={26} />
        </View>
      </View>
      <View style={styles.rail}>
        {stages.map((stage, index) => (
          <RailRow key={stage.key} stage={stage} origin={request.createdAt} last={index === stages.length - 1} />
        ))}
      </View>
      {request.detail ? (
        <Text style={styles.detail} numberOfLines={3} selectable>
          {request.detail}
        </Text>
      ) : null}
      {request.changedFiles?.length ? (
        <Text style={styles.files} numberOfLines={3} ellipsizeMode="head">
          {request.changedFiles.slice(0, 3).join("\n")}
          {request.changedFiles.length > 3 ? `\n+${request.changedFiles.length - 3} more` : ""}
        </Text>
      ) : null}
    </View>
  );
}

/** ¼ height: one live line — the instruction and the step it is on now. */
function ActiveLine({ request }: { request: TrackedRequest }) {
  const stages = requestLifecycle(request);
  const now =
    stages.find((s) => s.state === "failed" || s.state === "waiting" || s.state === "active") ??
    [...stages].reverse().find((s) => s.state === "done") ??
    stages[0];
  return (
    <View style={styles.earlierRow} accessibilityLiveRegion="polite">
      <View style={[styles.confDot, { backgroundColor: STAGE_TONE[now?.state ?? "pending"] }]} />
      <Text style={[styles.earlierText, { color: colors.text }]} numberOfLines={1}>
        {request.instruction}
      </Text>
      <Text style={[styles.railTime, { color: STAGE_TONE[now?.state ?? "pending"] }]} numberOfLines={1}>
        {now?.label}
      </Text>
    </View>
  );
}

function RailRow({ stage, origin, last }: { stage: LifecycleStage; origin: number; last: boolean }) {
  const tone = STAGE_TONE[stage.state];
  const reached = stage.state !== "pending";
  return (
    <View style={styles.railRow} accessibilityLabel={`${stage.label}, ${stage.state}`}>
      <View style={styles.railTrack}>
        <View
          style={[
            styles.railDot,
            reached ? { backgroundColor: tone, borderColor: tone } : { borderColor: colors.borderStrong },
            stage.state === "active" && styles.railDotActive,
          ]}
        />
        {!last ? <View style={[styles.railLine, stage.state === "done" && { backgroundColor: "rgba(61,214,140,0.35)" }]} /> : null}
      </View>
      <Text style={[styles.railLabel, !reached && { color: colors.textFaint }, stage.state === "failed" && { color: colors.danger }]} numberOfLines={1}>
        {stage.label}
      </Text>
      <Text style={styles.railTime}>{stage.at && stage.key !== "sent" ? formatElapsed(stage.at - origin) : ""}</Text>
    </View>
  );
}

function EarlierRow({ request, c }: { request: TrackedRequest; c: PanelController }) {
  const outcome = requestOutcome(request);
  return (
    <View style={styles.earlierRow}>
      <View style={[styles.confDot, { backgroundColor: STAGE_TONE[outcome] }]} />
      <Text style={styles.earlierText} numberOfLines={1}>
        {request.instruction}
      </Text>
      {canRetry(request) ? (
        <TextAction label="Retry" onPress={() => c.retryRequest(request.requestId)} />
      ) : (
        <Text style={styles.railTime}>{formatAgo(request.updatedAt)}</Text>
      )}
    </View>
  );
}

function formatAgo(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

function Composer({ c }: { c: PanelController }) {
  const { state, speech } = c;
  const listening = speech.status === "listening" || speech.status === "starting";
  const speechBlocked = !!speech.support && !speech.support.ok;
  const canSubmit = state.transcript.trim().length > 0 && !!c.selectedThreadId;
  // Only explain dictation problems once the mic has been tried; the dimmed mic is the hint.
  const speechNotice = speech.error;
  const hint =
    state.error ??
    (!c.selectedThreadId && c.connection.status === "connected" && state.transcript.trim() ? "Choose a thread first: tap the title." : null);

  return (
    <View style={styles.composerWrap}>
      {speechNotice ? (
        <Notice
          flush
          tone={colors.warning}
          text={speechNotice}
          action={
            speech.onlineAvailable
              ? { label: "Use online", onPress: c.allowOnlineSpeech }
              : speech.support?.canDownloadModel
                ? { label: "Get model", onPress: c.downloadSpeechModel }
                : undefined
          }
        />
      ) : null}
      {hint ? (
        <Text style={[styles.hint, !!state.error && { color: colors.danger }]} numberOfLines={2}>
          {hint}
        </Text>
      ) : null}
      <View style={[styles.composer, listening && styles.composerListening]}>
        <TextInput
          value={listening && speech.partial ? `${state.transcript}${state.transcript ? " " : ""}${speech.partial}` : state.transcript}
          onChangeText={c.setTranscript}
          editable={!listening}
          placeholder={listening ? `Listening · ${speech.onDevice ? "on device" : "online"}` : "Describe the change…"}
          placeholderTextColor={listening ? colors.danger : colors.textFaint}
          multiline
          style={styles.input}
          accessibilityLabel="Instruction"
        />
        <Pressable
          onPress={c.toggleMic}
          onLongPress={c.micPressIn}
          onPressOut={c.micPressOut}
          delayLongPress={250}
          hitSlop={4}
          accessibilityRole="button"
          accessibilityLabel={listening ? "Stop dictation" : "Start dictation"}
          accessibilityHint={speechBlocked ? "Dictation is unavailable; tap for details" : "Tap to toggle, or press and hold to talk"}
          style={({ pressed }) => [styles.roundBtn, listening ? styles.micLive : styles.micIdle, pressed && { opacity: 0.8 }, speechBlocked && { opacity: 0.3 }]}
        >
          <Text style={[styles.roundGlyph, !listening && { color: colors.textMuted }]}>{listening ? "■" : "🎙"}</Text>
        </Pressable>
        <Pressable
          onPress={c.submit}
          disabled={!canSubmit}
          hitSlop={4}
          accessibilityRole="button"
          accessibilityLabel={c.connection.status === "connected" ? "Send to agent" : "Queue until connected"}
          accessibilityState={{ disabled: !canSubmit }}
          style={({ pressed }) => [styles.roundBtn, styles.send, pressed && { backgroundColor: colors.accentPressed }, !canSubmit && styles.sendDisabled]}
        >
          <Text style={styles.roundGlyph}>↑</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Notice({ tone, text, action, flush }: { tone: string; text: string; action?: { label: string; onPress(): void } | undefined; flush?: boolean }) {
  return (
    <View style={[styles.notice, flush && { marginHorizontal: 0, marginTop: 0 }]}>
      <View style={[styles.confDot, { backgroundColor: tone }]} />
      <Text style={styles.noticeText} numberOfLines={2}>
        {text}
      </Text>
      {action ? <TextAction label={action.label} onPress={action.onPress} /> : null}
    </View>
  );
}

function TextAction({ label, onPress, tone = colors.accent }: { label: string; onPress(): void; tone?: string }) {
  return (
    <Pressable onPress={onPress} hitSlop={10} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => [styles.textAction, pressed && { opacity: 0.6 }]}>
      <Text style={[styles.textActionLabel, { color: tone === colors.accent ? "#B9AFFF" : tone }]}>{label}</Text>
    </Pressable>
  );
}

// --- threads -------------------------------------------------------------------------------------

function ThreadsView({ c }: { c: PanelController }) {
  return (
    <ScrollView style={styles.feed} contentContainerStyle={styles.feedContent}>
      {c.threadsError ? <Notice tone={colors.danger} text={c.threadsError} action={{ label: "Retry", onPress: c.refreshThreads }} /> : null}
      {c.threads.length === 0 && !c.threadsError ? (
        <Text style={styles.empty}>No threads. Start one in T3 Code for this project.</Text>
      ) : null}
      {c.threads.map((thread) => {
        const selected = thread.threadId === c.selectedThreadId;
        return (
          <Pressable
            key={thread.threadId}
            onPress={() => c.selectThread(thread.threadId)}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            style={({ pressed }) => [styles.listRow, pressed && styles.stripPressed]}
          >
            <Text style={[styles.check, !selected && { opacity: 0 }]}>✓</Text>
            <Text style={[styles.listLabel, { flex: 1 }]} numberOfLines={1}>
              {thread.title || thread.threadId}
            </Text>
            <Text style={styles.listValue} numberOfLines={1}>
              {thread.status}
            </Text>
          </Pressable>
        );
      })}
      <View style={{ marginTop: space.sm, alignItems: "flex-start" }}>
        <TextAction label="Refresh list" onPress={c.refreshThreads} />
      </View>
    </ScrollView>
  );
}

// --- settings menu -------------------------------------------------------------------------------

function MenuView({ c }: { c: PanelController }) {
  const { settings } = c.state;
  const thread = c.threads.find((t) => t.threadId === c.selectedThreadId);
  const steerSupported = c.connection.status === "connected" && c.connection.capabilities.steer;
  const modes: DeliveryMode[] = ["queue", "auto", "steer"];
  const conn = connectionSummary(c.connection);
  const reason = c.connection.status === "disconnected" || c.connection.status === "failed" ? c.connection.reason : undefined;
  return (
    <ScrollView style={styles.feed} contentContainerStyle={styles.feedContent}>
      <Text style={styles.sectionLabel}>Request</Text>
      <Pressable onPress={() => c.setView("threads")} style={({ pressed }) => [styles.listRow, pressed && styles.stripPressed]} accessibilityRole="button">
        <Text style={styles.listLabel}>Thread</Text>
        <Text style={[styles.listValue, { flex: 1 }]} numberOfLines={1}>
          {thread ? thread.title || thread.threadId : "None"}
        </Text>
        <Text style={styles.caret}>›</Text>
      </Pressable>
      <ToggleRow
        label="Attach screenshot"
        value={settings.screenshots && c.screenshotsAvailable}
        disabled={!c.screenshotsAvailable}
        note={c.screenshotsAvailable ? undefined : "needs view-shot"}
        onChange={(v) => c.setSetting("screenshots", v)}
      />
      <ToggleRow label="Send after dictation" value={settings.autoSubmit} onChange={(v) => c.setSetting("autoSubmit", v)} />
      <View style={styles.listRow}>
        <Text style={[styles.listLabel, { flex: 1 }]}>Delivery</Text>
        <View style={styles.segment}>
          {modes.map((mode) => {
            const disabled = mode === "steer" && !steerSupported;
            const selected = settings.mode === mode;
            return (
              <Pressable
                key={mode}
                disabled={disabled}
                onPress={() => c.setSetting("mode", mode)}
                accessibilityRole="button"
                accessibilityLabel={`Delivery ${mode}`}
                accessibilityState={{ selected, disabled }}
                style={[styles.segmentItem, selected && styles.segmentSelected, disabled && { opacity: 0.3 }]}
              >
                <Text style={[styles.segmentText, selected && { color: colors.text }]}>{mode}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <Text style={[styles.sectionLabel, { marginTop: space.lg }]}>Connection</Text>
      <View style={styles.listRow}>
        <View style={[styles.confDot, { backgroundColor: conn.color }]} />
        <Text style={[styles.listLabel, { flex: 1 }]} numberOfLines={1}>
          {conn.label}
        </Text>
        <TextAction label="Reconnect" onPress={c.reconnect} />
      </View>
      {reason ? <Text style={styles.hint}>{reason}</Text> : null}
      <KeyValue k="Bridge" v={c.bridgeUrl ?? "unknown"} />
      <KeyValue k="Project" v={c.projectId} />
      {c.connection.status === "connected" ? <KeyValue k="Adapter" v={c.connection.capabilities.adapter} /> : null}
      <KeyValue k="Fast Refresh" v={c.refreshSupported ? "observed" : "not observable"} />
      <View style={{ marginTop: space.md, alignItems: "flex-start" }}>
        <TextAction label="Unpair this device" tone={colors.danger} onPress={c.unpair} />
      </View>
    </ScrollView>
  );
}

function ToggleRow({ label, value, onChange, disabled, note }: { label: string; value: boolean; onChange(v: boolean): void; disabled?: boolean; note?: string | undefined }) {
  return (
    <View style={styles.listRow}>
      <Text style={[styles.listLabel, { flex: 1 }, disabled && { color: colors.textFaint }]}>{label}</Text>
      {note ? <Text style={styles.listValue}>{note}</Text> : null}
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ true: colors.accent, false: "#2E3340" }}
        thumbColor="#FFFFFF"
        accessibilityLabel={label}
        style={styles.switch}
      />
    </View>
  );
}

function KeyValue({ k, v }: { k: string; v: string }) {
  return (
    <View style={styles.kvRow}>
      <Text style={styles.kvKey}>{k}</Text>
      <Text style={styles.kvValue} numberOfLines={1} ellipsizeMode="middle" selectable>
        {v}
      </Text>
    </View>
  );
}

// --- pairing -------------------------------------------------------------------------------------

type LinkCheck = { state: "idle" } | { state: "checking"; url: string } | { state: "done"; probe: BridgeProbe };

/** Debounced GET /health against the URL being edited, so "not the bridge" shows before pairing. */
function useLinkCheck(url: string, probe: PanelController["probeBridge"]) {
  const [check, setCheck] = useState<LinkCheck>({ state: "idle" });
  const [nonce, setNonce] = useState(0);
  const latest = useRef(0);
  useEffect(() => {
    const target = url.trim().replace(/\/$/, "");
    if (!/^https?:\/\/[^/\s]+/.test(target)) {
      setCheck({ state: "idle" });
      return;
    }
    const id = ++latest.current;
    setCheck({ state: "checking", url: target });
    const timer = setTimeout(() => {
      probe(target).then(
        (result) => {
          if (id === latest.current) setCheck({ state: "done", probe: result });
        },
        (error: unknown) => {
          if (id === latest.current)
            setCheck({ state: "done", probe: { ok: false, url: target, kind: "unreachable", detail: (error as Error).message } });
        },
      );
    }, 450);
    return () => clearTimeout(timer);
  }, [url, probe, nonce]);
  return { check, retest: () => setNonce((n) => n + 1) };
}

function LinkStatus({ check, onRetest }: { check: LinkCheck; onRetest(): void }) {
  if (check.state === "idle") return null;
  const failed = check.state === "done" && !check.probe.ok;
  const tone = check.state === "checking" ? colors.textFaint : failed ? colors.danger : colors.success;
  const text =
    check.state === "checking"
      ? `Checking ${check.url}…`
      : check.probe.ok
        ? `Reached expo-ai-bridge ${check.probe.version}`
        : check.probe.detail;
  return (
    <View style={styles.linkStatus} accessibilityLiveRegion="polite">
      <View style={[styles.confDot, { backgroundColor: tone, marginTop: 5 }]} />
      <Text style={[styles.hint, { flex: 1, marginTop: 0 }, failed && { color: colors.danger }]} selectable>
        {text}
      </Text>
      {check.state === "done" ? <TextAction label="Test" onPress={onRetest} /> : null}
    </View>
  );
}

function PairView({ c }: { c: PanelController }) {
  const [url, setUrl] = useState(c.bridgeUrl ?? "http://");
  const edited = useRef(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(c.connection.status === "unpaired" ? (c.connection.reason ?? null) : null);
  const { check, retest } = useLinkCheck(url, c.probeBridge);

  // Follow a newly discovered URL until the user types their own, so only one URL is ever shown.
  useEffect(() => {
    if (!edited.current && c.bridgeUrl) setUrl(c.bridgeUrl);
  }, [c.bridgeUrl]);

  const onPair = async () => {
    setBusy(true);
    setError(null);
    try {
      await c.pair(url.trim(), code.trim());
    } catch (pairError) {
      setError((pairError as Error).message);
      retest();
    } finally {
      setBusy(false);
    }
  };
  const ready = !busy && code.length === 6;
  return (
    <ScrollView style={styles.feed} keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.feedContent, { gap: space.md }]}>
      <View>
        <Text style={styles.sectionLabel}>Bridge URL</Text>
        <TextInput
          value={url}
          onChangeText={(text) => {
            edited.current = true;
            setUrl(text);
          }}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          style={styles.field}
          placeholder="http://127.0.0.1:8790"
          placeholderTextColor={colors.textFaint}
          accessibilityLabel="Bridge URL"
        />
        <LinkStatus check={check} onRetest={retest} />
      </View>
      <View>
        <Text style={styles.sectionLabel}>Pairing code</Text>
        <TextInput
          value={code}
          onChangeText={(text) => setCode(text.replace(/\D/g, "").slice(0, 6))}
          keyboardType="number-pad"
          placeholder="000000"
          placeholderTextColor={colors.textFaint}
          style={[styles.field, styles.codeField]}
          maxLength={6}
          accessibilityLabel="Pairing code"
        />
        <Text style={styles.hint}>
          From the bridge terminal. Expired? Press p there, or run <Text style={styles.inlineCode}>expo-ai-bridge pair-code</Text>.
        </Text>
      </View>
      {error ? (
        <Text style={[styles.hint, { color: colors.danger, marginTop: 0 }]} selectable>
          {error}
        </Text>
      ) : null}
      <Pressable
        onPress={onPair}
        disabled={!ready}
        accessibilityRole="button"
        accessibilityLabel="Pair"
        accessibilityState={{ disabled: !ready }}
        style={({ pressed }) => [styles.pairBtn, pressed && { backgroundColor: colors.accentPressed }, !ready && styles.sendDisabled]}
      >
        <Text style={styles.pairLabel}>{busy ? "Pairing…" : "Pair"}</Text>
      </Pressable>
    </ScrollView>
  );
}

// --- styles --------------------------------------------------------------------------------------

const ROW = 40;

const styles = StyleSheet.create({
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    // Opaque: the app must not bleed through behind the event rail.
    backgroundColor: "#111319",
    borderTopLeftRadius: radius.lg + 6,
    borderTopRightRadius: radius.lg + 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
  },
  grabberZone: { alignItems: "center", paddingTop: space.sm, paddingBottom: 2 },
  grabber: { width: 40, height: 4, borderRadius: 2, backgroundColor: colors.borderStrong },
  header: { flexDirection: "row", alignItems: "center", paddingLeft: space.sm, paddingRight: space.xs, height: 44 },
  headerTarget: { flex: 1, flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.sm, height: 40 },
  headerTitle: { ...type.title, fontSize: 15, flexShrink: 1 },
  liveDot: { width: 8, height: 8, borderRadius: 4 },
  caret: { color: colors.textFaint, fontSize: 12 },

  main: { flex: 1 },
  feed: { flex: 1 },
  feedContent: { paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.md },
  sectionLabel: { ...type.label, fontSize: 10, color: colors.textFaint, marginBottom: space.xs },
  empty: { ...type.caption, color: colors.textFaint, paddingVertical: space.md },

  strip: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    marginHorizontal: space.lg,
    paddingLeft: space.md,
    paddingRight: space.xs,
    height: ROW,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  stripPressed: { backgroundColor: "rgba(255,255,255,0.05)" },
  stripMain: { flex: 1, flexDirection: "row", alignItems: "center", gap: space.sm, height: ROW },
  stripGlyph: { color: "#B9AFFF", fontSize: 16 },
  stripText: { fontSize: 14, fontWeight: "600", color: colors.text, flexShrink: 1 },
  stripPath: { fontFamily: mono, fontSize: 11, color: colors.textFaint, flexShrink: 2, marginLeft: "auto" },
  confDot: { width: 7, height: 7, borderRadius: 4 },

  requestHead: { flexDirection: "row", alignItems: "flex-start", gap: space.sm, marginBottom: space.sm },
  instruction: { flex: 1, fontSize: 14, lineHeight: 19, color: colors.text, fontWeight: "500" },
  inlineActions: { flexDirection: "row", alignItems: "center", gap: space.xs, marginTop: -4 },

  rail: { paddingLeft: 2 },
  railRow: { flexDirection: "row", alignItems: "center", height: 26, gap: space.md },
  railTrack: { width: 10, height: 26, alignItems: "center", justifyContent: "center" },
  railDot: { width: 9, height: 9, borderRadius: 5, borderWidth: 1.5, backgroundColor: "transparent", zIndex: 1 },
  railDotActive: { shadowColor: colors.accent, shadowOpacity: 0.9, shadowRadius: 5, shadowOffset: { width: 0, height: 0 }, elevation: 3 },
  railLine: { position: "absolute", top: 17.5, bottom: -9, width: 1.5, backgroundColor: colors.border },
  railLabel: { flex: 1, fontSize: 13, color: colors.text },
  railTime: { fontFamily: mono, fontSize: 11, color: colors.textFaint, fontVariant: ["tabular-nums"] },
  detail: { ...type.caption, marginTop: space.sm },
  files: { fontFamily: mono, fontSize: 11, lineHeight: 16, color: colors.textMuted, marginTop: space.xs },

  earlierRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    height: 34,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  earlierText: { flex: 1, fontSize: 13, color: colors.textMuted },

  composerWrap: {
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: space.xs,
    backgroundColor: colors.surfaceSunken,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    paddingLeft: space.lg,
    padding: 4,
  },
  composerListening: { borderColor: colors.danger },
  input: { flex: 1, minHeight: 36, maxHeight: 96, color: colors.text, fontSize: 15, paddingVertical: 8, textAlignVertical: "top" },
  roundBtn: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  micIdle: { backgroundColor: "transparent" },
  micLive: { backgroundColor: colors.danger },
  send: { backgroundColor: colors.accent },
  sendDisabled: { backgroundColor: "#2A2F3B", opacity: 0.7 },
  roundGlyph: { color: "#FFFFFF", fontSize: 16, fontWeight: "700" },
  hint: { ...type.caption, color: colors.textMuted, marginTop: space.xs, marginBottom: space.xs, paddingHorizontal: space.xs },

  notice: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    marginHorizontal: space.lg,
    marginTop: space.sm,
    marginBottom: space.xs,
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radius.md,
    backgroundColor: "rgba(245,184,65,0.08)",
  },
  noticeText: { flex: 1, fontSize: 12, lineHeight: 16, color: colors.text },
  textAction: { paddingHorizontal: 6, paddingVertical: 4 },
  textActionLabel: { fontSize: 13, fontWeight: "600" },

  listRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    minHeight: 44,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  listLabel: { fontSize: 14, color: colors.text },
  listValue: { fontSize: 13, color: colors.textMuted, textAlign: "right" },
  check: { color: "#B9AFFF", fontSize: 14, width: 16 },
  switch: { transform: [{ scale: 0.85 }] },
  segment: { flexDirection: "row", backgroundColor: colors.surfaceSunken, borderRadius: radius.sm, padding: 2 },
  segmentItem: { paddingHorizontal: space.md, paddingVertical: 5, borderRadius: radius.sm - 2 },
  segmentSelected: { backgroundColor: colors.surfaceRaised },
  segmentText: { fontSize: 12, fontWeight: "600", color: colors.textMuted },
  kvRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", height: 28, gap: space.md },
  kvKey: { fontSize: 12, color: colors.textFaint },
  kvValue: { fontFamily: mono, fontSize: 11, color: colors.textMuted, flexShrink: 1 },

  field: {
    backgroundColor: colors.surfaceSunken,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    color: colors.text,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    fontSize: 15,
  },
  codeField: { fontFamily: mono, fontSize: 22, letterSpacing: 8, textAlign: "center" },
  linkStatus: { flexDirection: "row", alignItems: "flex-start", gap: space.sm, marginTop: space.sm },
  inlineCode: { fontFamily: mono, color: colors.text },
  pairBtn: { height: 44, borderRadius: 22, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center" },
  pairLabel: { color: "#FFFFFF", fontSize: 15, fontWeight: "700" },
});
