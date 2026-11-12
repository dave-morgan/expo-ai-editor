import type { DeliveryMode, Selection, ThreadSummary } from "@expo-ai/protocol";
import React, { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import type { ConnectionState } from "../bridge/client";
import type { SpeechStatus, SpeechSupport } from "../platform/speech";
import {
  agentStep,
  canCancel,
  canRetry,
  PHASE_LABELS,
  refreshStep,
  type InspectorState,
  type TrackedRequest,
} from "../state/inspector-state";
import { Badge, Button, IconButton, StatusDot } from "./primitives";
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

export function Panel({ c, bottomInset }: { c: PanelController; bottomInset: number }) {
  const { state } = c;
  const conn = connectionSummary(c.connection);
  const thread = c.threads.find((t) => t.threadId === c.selectedThreadId);
  const view = c.connection.status === "unpaired" ? "pair" : state.view;

  return (
    <View style={[styles.panel, { paddingBottom: space.md + bottomInset }]} accessibilityViewIsModal>
      <View style={styles.grabber} />
      <View style={styles.header}>
        <Pressable
          style={styles.headerTarget}
          onPress={() => c.setView(view === "threads" ? "main" : "threads")}
          accessibilityRole="button"
          accessibilityLabel="Choose T3 thread"
        >
          <StatusDot color={conn.color} />
          <View style={{ flexShrink: 1 }}>
            <Text style={type.title} numberOfLines={1}>
              {thread ? thread.title : c.connection.status === "connected" ? "Choose a T3 thread" : conn.label}
            </Text>
            <Text style={type.caption} numberOfLines={1}>
              {c.connection.status === "connected" ? `${c.connection.projectName} · ${thread ? thread.status : "no thread"}` : c.bridgeUrl ?? "Bridge URL unknown"}
            </Text>
          </View>
          <Text style={styles.chevron}>{view === "threads" ? "▴" : "▾"}</Text>
        </Pressable>
        <IconButton glyph="⟲" label="Recent instructions" active={view === "history"} onPress={() => c.setView(view === "history" ? "main" : "history")} />
        <IconButton glyph="⚙" label="Settings" active={view === "settings"} onPress={() => c.setView(view === "settings" ? "main" : "settings")} />
        <IconButton glyph="✕" label="Close inspector" onPress={c.close} />
      </View>

      {view === "pair" && <PairView c={c} />}
      {view === "threads" && <ThreadsView c={c} />}
      {view === "history" && <HistoryView c={c} />}
      {view === "settings" && <SettingsView c={c} />}
      {view === "main" && <MainView c={c} />}
    </View>
  );
}

function SelectionSummary({ selection, c }: { selection: Selection; c: PanelController }) {
  const tone = selection.confidence === "high" ? "good" : selection.confidence === "medium" ? "warn" : "bad";
  return (
    <View style={styles.card}>
      <View style={styles.rowBetween}>
        <View style={{ flexShrink: 1 }}>
          <Text style={type.title} numberOfLines={1}>
            {selection.componentName ? `${selection.componentName} › ` : ""}
            <Text style={{ color: "#B9AFFF" }}>{selection.elementType}</Text>
          </Text>
          {selection.source ? (
            <Text style={[type.code, { color: colors.textMuted }]} numberOfLines={1} ellipsizeMode="head">
              {selection.source.file}:{selection.source.line}
            </Text>
          ) : (
            <Text style={type.caption}>Source location unavailable</Text>
          )}
        </View>
        <Badge label={selection.confidence} tone={tone} />
      </View>
      {selection.visibleText ? (
        <Text style={[type.caption, { marginTop: space.xs }]} numberOfLines={2}>
          “{selection.visibleText}”
        </Text>
      ) : null}
      {selection.confidenceNotes.length > 0 && selection.confidence !== "high" ? (
        <Text style={[type.caption, { color: colors.warning, marginTop: space.xs }]} numberOfLines={3}>
          {selection.confidenceNotes[0]}
        </Text>
      ) : null}
      <View style={[styles.row, { marginTop: space.sm, gap: space.sm }]}>
        <Button compact label="Reselect" onPress={c.reselect} />
        <Button compact variant="ghost" label="Clear" onPress={c.clearSelection} />
      </View>
    </View>
  );
}

function MainView({ c }: { c: PanelController }) {
  const { state, speech } = c;
  const active = state.activeRequestId ? state.requests[state.activeRequestId] : undefined;
  const listening = speech.status === "listening" || speech.status === "starting";
  const speechBlocked = speech.support && !speech.support.ok;
  const connected = c.connection.status === "connected";
  const canSubmit = state.transcript.trim().length > 0 && !!c.selectedThreadId;

  return (
    <ScrollView style={styles.body} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: space.md }}>
      {state.selection ? (
        <SelectionSummary selection={state.selection} c={c} />
      ) : (
        <View style={styles.card}>
          <Text style={type.body}>No element selected.</Text>
          <Text style={type.caption}>You can still send an instruction without a selection.</Text>
          <Button compact label="Select element" onPress={c.reselect} style={{ marginTop: space.sm, alignSelf: "flex-start" }} />
        </View>
      )}

      {active ? <RequestStatus request={active} c={c} /> : null}

      <View>
        <View style={styles.inputWrap}>
          <TextInput
            value={listening && speech.partial ? `${state.transcript}${state.transcript ? " " : ""}${speech.partial}` : state.transcript}
            onChangeText={c.setTranscript}
            editable={!listening}
            placeholder={listening ? "Listening…" : "Describe the change, or hold the mic to dictate"}
            placeholderTextColor={colors.textFaint}
            multiline
            style={styles.input}
            accessibilityLabel="Instruction"
          />
          <Pressable
            onPress={c.toggleMic}
            onLongPress={c.micPressIn}
            onPressOut={c.micPressOut}
            delayLongPress={250}
            disabled={!!speechBlocked}
            accessibilityRole="button"
            accessibilityLabel={listening ? "Stop dictation" : "Start dictation"}
            accessibilityHint="Tap to toggle, or press and hold to talk"
            style={({ pressed }) => [styles.mic, listening && styles.micActive, pressed && { opacity: 0.85 }, speechBlocked && { opacity: 0.35 }]}
          >
            <Text style={styles.micGlyph}>{listening ? "■" : "🎙"}</Text>
          </Pressable>
        </View>
        {speech.error || (speechBlocked && speech.support?.reason) ? (
          <View style={[styles.row, { marginTop: space.xs, gap: space.sm, flexWrap: "wrap" }]}>
            <Text style={[type.caption, { color: colors.warning, flexShrink: 1 }]}>{speech.error ?? speech.support?.reason}</Text>
            {speech.support?.canDownloadModel ? <Button compact label={`Download ${speech.locale} model`} onPress={c.downloadSpeechModel} /> : null}
          </View>
        ) : (
          <Text style={[type.caption, { marginTop: space.xs }]}>
            {listening ? `On-device · ${speech.locale}` : state.inputMethod === "typed" ? "Typed" : state.inputMethod === "voice" ? "Dictated on device" : "Dictated, edited"}
          </Text>
        )}
      </View>

      {state.error ? <Text style={[type.caption, { color: colors.danger }]}>{state.error}</Text> : null}

      <View style={[styles.row, { gap: space.sm }]}>
        <Button
          variant="primary"
          label={connected ? "Send to agent" : "Queue (offline)"}
          onPress={c.submit}
          disabled={!canSubmit}
          style={{ flex: 1 }}
        />
        <Button variant="ghost" label="Cancel" onPress={c.close} />
      </View>
      {!c.selectedThreadId && connected ? (
        <Text style={type.caption}>Pick the T3 thread to send to from the header.</Text>
      ) : null}
    </ScrollView>
  );
}

const STEP_TONE = { done: colors.success, active: colors.accent, waiting: colors.warning, failed: colors.danger, idle: colors.textFaint };

function Step({ label, state }: { label: string; state: keyof typeof STEP_TONE }) {
  return (
    <View style={styles.step}>
      <View style={[styles.stepDot, { backgroundColor: STEP_TONE[state] }]} />
      <Text style={[type.caption, state === "idle" && { color: colors.textFaint }, state !== "idle" && { color: colors.text }]}>{label}</Text>
    </View>
  );
}

function RequestStatus({ request, c }: { request: TrackedRequest; c: PanelController }) {
  const agent = agentStep(request);
  const refresh = refreshStep(request);
  const delivered = !!(request.seen.submitted || request.seen.agent_working || request.seen.agent_completed);
  const failed = request.phase === "failed" || request.phase === "cancelled";
  return (
    <View style={styles.card} accessibilityLiveRegion="polite">
      <View style={styles.rowBetween}>
        <Text style={type.label}>Request</Text>
        <Text style={[type.caption, failed && { color: colors.danger }]}>{PHASE_LABELS[request.phase]}</Text>
      </View>
      <Text style={[type.body, { marginTop: space.xs }]} numberOfLines={2}>
        {request.instruction}
      </Text>
      <View style={[styles.row, { marginTop: space.sm, gap: space.md, flexWrap: "wrap" }]}>
        <Step label={request.seen.queued && !delivered ? "Queued" : "Delivered"} state={failed && !delivered ? "failed" : delivered ? "done" : "active"} />
        <Step
          label={agent === "waiting" ? "Needs input" : agent === "completed" ? "Agent done" : agent === "failed" ? "Agent failed" : "Agent"}
          state={agent === "completed" ? "done" : agent === "working" ? "active" : agent === "waiting" ? "waiting" : agent === "failed" ? "failed" : "idle"}
        />
        <Step label="Files changed" state={refresh !== "none" ? "done" : "idle"} />
        <Step
          label={refresh === "native" ? "Rebuild needed" : refresh === "failed" ? "Refresh failed" : "Refreshed"}
          state={refresh === "observed" ? "done" : refresh === "failed" ? "failed" : refresh === "native" ? "waiting" : "idle"}
        />
      </View>
      {request.detail ? (
        <Text style={[type.caption, { marginTop: space.sm }]} numberOfLines={4}>
          {request.detail}
        </Text>
      ) : null}
      {request.changedFiles?.length ? (
        <Text style={[type.code, { color: colors.textMuted, marginTop: space.xs }]} numberOfLines={3}>
          {request.changedFiles.slice(0, 4).join("\n")}
        </Text>
      ) : null}
      <View style={[styles.row, { marginTop: space.sm, gap: space.sm }]}>
        {canCancel(request) ? <Button compact variant="danger" label="Cancel request" onPress={() => c.cancelRequest(request.requestId)} /> : null}
        {canRetry(request) ? <Button compact label="Retry" onPress={() => c.retryRequest(request.requestId)} /> : null}
        <Button compact variant="ghost" label="Dismiss" onPress={c.dismissRequest} />
      </View>
    </View>
  );
}

function ThreadsView({ c }: { c: PanelController }) {
  return (
    <ScrollView style={styles.body} contentContainerStyle={{ gap: space.xs }}>
      <View style={styles.rowBetween}>
        <Text style={type.label}>T3 threads in this project</Text>
        <Button compact variant="ghost" label="Refresh" onPress={c.refreshThreads} />
      </View>
      {c.threadsError ? <Text style={[type.caption, { color: colors.danger }]}>{c.threadsError}</Text> : null}
      {c.threads.length === 0 && !c.threadsError ? <Text style={type.caption}>No threads found. Start one in T3 Code for this project.</Text> : null}
      {c.threads.map((thread) => {
        const selected = thread.threadId === c.selectedThreadId;
        return (
          <Pressable
            key={thread.threadId}
            onPress={() => c.selectThread(thread.threadId)}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            style={({ pressed }) => [styles.threadRow, selected && styles.threadRowSelected, pressed && { opacity: 0.8 }]}
          >
            <View style={{ flex: 1 }}>
              <Text style={type.body} numberOfLines={1}>
                {thread.title || thread.threadId}
              </Text>
              <Text style={type.caption} numberOfLines={1}>
                {thread.status}
                {thread.model ? ` · ${thread.model}` : ""}
              </Text>
            </View>
            {selected ? <Badge label="target" tone="accent" /> : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function HistoryView({ c }: { c: PanelController }) {
  const items = c.state.history.map((id) => c.state.requests[id]).filter((r): r is TrackedRequest => !!r);
  return (
    <ScrollView style={styles.body} contentContainerStyle={{ gap: space.sm }}>
      <Text style={type.label}>Recent instructions</Text>
      {items.length === 0 ? <Text style={type.caption}>Nothing sent yet.</Text> : null}
      {items.map((request) => (
        <View key={request.requestId} style={styles.historyRow}>
          <View style={{ flex: 1 }}>
            <Text style={type.body} numberOfLines={2}>
              {request.instruction}
            </Text>
            <Text style={type.caption} numberOfLines={1}>
              {request.componentName ? `${request.componentName} · ` : ""}
              {PHASE_LABELS[request.phase]}
            </Text>
          </View>
          {canRetry(request) ? <Button compact label="Retry" onPress={() => c.retryRequest(request.requestId)} /> : null}
        </View>
      ))}
    </ScrollView>
  );
}

function SettingRow({ label, hint, value, onChange, disabled }: { label: string; hint?: string; value: boolean; onChange(v: boolean): void; disabled?: boolean }) {
  return (
    <View style={styles.settingRow}>
      <View style={{ flex: 1 }}>
        <Text style={type.body}>{label}</Text>
        {hint ? <Text style={type.caption}>{hint}</Text> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ true: colors.accent, false: "#3A404D" }}
        thumbColor="#FFFFFF"
        accessibilityLabel={label}
      />
    </View>
  );
}

function SettingsView({ c }: { c: PanelController }) {
  const { settings } = c.state;
  const steerSupported = c.connection.status === "connected" && c.connection.capabilities.steer;
  const modes: DeliveryMode[] = ["queue", "auto", "steer"];
  return (
    <ScrollView style={styles.body} contentContainerStyle={{ gap: space.md }}>
      <SettingRow
        label="Attach screenshot"
        hint={c.screenshotsAvailable ? "Compact JPEG of the app (inspector hidden)" : "Install react-native-view-shot to enable"}
        value={settings.screenshots && c.screenshotsAvailable}
        disabled={!c.screenshotsAvailable}
        onChange={(v) => c.setSetting("screenshots", v)}
      />
      <SettingRow label="Auto-submit after dictation" hint="Send as soon as the final transcript arrives" value={settings.autoSubmit} onChange={(v) => c.setSetting("autoSubmit", v)} />
      <View>
        <Text style={type.label}>Delivery</Text>
        <View style={[styles.segment, { marginTop: space.xs }]}>
          {modes.map((mode) => {
            const disabled = mode === "steer" && !steerSupported;
            const selected = settings.mode === mode;
            return (
              <Pressable
                key={mode}
                disabled={disabled}
                onPress={() => c.setSetting("mode", mode)}
                accessibilityRole="button"
                accessibilityState={{ selected, disabled }}
                style={[styles.segmentItem, selected && styles.segmentSelected, disabled && { opacity: 0.35 }]}
              >
                <Text style={[type.caption, selected && { color: colors.text, fontWeight: "600" }]}>{mode}</Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={[type.caption, { marginTop: space.xs }]}>
          {steerSupported ? "Queue waits for the current turn; steer joins it." : "Queue delivers as the thread's next turn and never interrupts. Steering is not offered by this agent adapter."}
        </Text>
      </View>
      <View style={styles.card}>
        <Text style={type.label}>Connection</Text>
        <Detail k="Bridge" v={c.bridgeUrl ?? "unknown"} />
        <Detail k="Project" v={c.projectId} />
        <Detail k="Status" v={connectionSummary(c.connection).label + (c.connection.status === "disconnected" && c.connection.reason ? ` (${c.connection.reason})` : c.connection.status === "failed" ? ` (${c.connection.reason})` : "")} />
        {c.connection.status === "connected" ? <Detail k="Adapter" v={c.connection.capabilities.adapter} /> : null}
        <Detail k="Fast Refresh" v={c.refreshSupported ? "observed" : "not observable"} />
        <View style={[styles.row, { gap: space.sm, marginTop: space.sm }]}>
          <Button compact label="Reconnect" onPress={c.reconnect} />
          <Button compact variant="danger" label="Unpair" onPress={c.unpair} />
        </View>
      </View>
    </ScrollView>
  );
}

function Detail({ k, v }: { k: string; v: string }) {
  return (
    <View style={[styles.rowBetween, { marginTop: space.xs }]}>
      <Text style={type.caption}>{k}</Text>
      <Text style={[type.code, { flexShrink: 1, marginLeft: space.md }]} numberOfLines={1} ellipsizeMode="middle">
        {v}
      </Text>
    </View>
  );
}

function PairView({ c }: { c: PanelController }) {
  const [url, setUrl] = useState(c.bridgeUrl ?? "http://");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(c.connection.status === "unpaired" ? (c.connection.reason ?? null) : null);
  const onPair = async () => {
    setBusy(true);
    setError(null);
    try {
      await c.pair(url.trim(), code.trim());
    } catch (pairError) {
      setError((pairError as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={[styles.body, { gap: space.md }]}>
      <Text style={type.body}>Pair with the bridge running on your computer. The 6-digit code is printed in the bridge terminal.</Text>
      <View>
        <Text style={type.label}>Bridge URL</Text>
        <TextInput value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} keyboardType="url" style={styles.field} placeholderTextColor={colors.textFaint} accessibilityLabel="Bridge URL" />
      </View>
      <View>
        <Text style={type.label}>Pairing code</Text>
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
      </View>
      {error ? <Text style={[type.caption, { color: colors.danger }]}>{error}</Text> : null}
      <Button variant="primary" label={busy ? "Pairing…" : "Pair"} disabled={busy || code.length !== 6} onPress={onPair} />
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: "72%",
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg + 4,
    borderTopRightRadius: radius.lg + 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    paddingHorizontal: space.lg,
  },
  grabber: { alignSelf: "center", width: 36, height: 4, borderRadius: 2, backgroundColor: colors.borderStrong, marginTop: space.sm },
  header: { flexDirection: "row", alignItems: "center", gap: space.xs, paddingVertical: space.sm },
  headerTarget: { flex: 1, flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: space.xs },
  chevron: { color: colors.textMuted, fontSize: 12 },
  body: { flexGrow: 0 },
  card: { backgroundColor: colors.surfaceRaised, borderRadius: radius.md, padding: space.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  row: { flexDirection: "row", alignItems: "center" },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm },
  inputWrap: {
    flexDirection: "row",
    alignItems: "flex-end",
    backgroundColor: colors.surfaceSunken,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    padding: space.xs,
    paddingLeft: space.md,
  },
  input: { flex: 1, minHeight: 44, maxHeight: 120, color: colors.text, fontSize: 15, paddingVertical: space.sm, textAlignVertical: "top" },
  mic: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center", marginLeft: space.xs },
  micActive: { backgroundColor: colors.danger },
  micGlyph: { fontSize: 18, color: "#fff" },
  step: { flexDirection: "row", alignItems: "center", gap: 6 },
  stepDot: { width: 7, height: 7, borderRadius: 4 },
  threadRow: { flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.md, borderRadius: radius.md, backgroundColor: colors.surfaceRaised },
  threadRowSelected: { borderWidth: 1, borderColor: colors.accent },
  historyRow: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  settingRow: { flexDirection: "row", alignItems: "center", gap: space.md },
  segment: { flexDirection: "row", backgroundColor: colors.surfaceSunken, borderRadius: radius.md, padding: 3 },
  segmentItem: { flex: 1, alignItems: "center", paddingVertical: space.sm, borderRadius: radius.sm },
  segmentSelected: { backgroundColor: colors.surfaceRaised },
  field: {
    marginTop: space.xs,
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
});
