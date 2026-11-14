import React, { useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  StyleSheet,
  View,
  type GestureResponderEvent,
} from "react-native";
import { colors } from "./theme";

interface IndicatorProps {
  enabled: boolean;
  recording: boolean;
  tone: "ready" | "disconnected" | "error" | "working" | "done";
  top: number;
  onToggle(): void;
  onHoldStart(): void;
  onHoldEnd(): void;
  onHoldCancel(): void;
  onOpenPanel(): void;
}

type Gesture = { x: number; y: number; kind: "press" | "hold" | "moved" | "swiped" };

export function Indicator(props: IndicatorProps) {
  const callbacks = useRef(props);
  callbacks.current = props;
  const gesture = useRef<Gesture | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pulse = useRef(new Animated.Value(1)).current;
  const [reduceMotion, setReduceMotion] = useState(true);

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const cancel = () => {
    clearTimer();
    if (gesture.current?.kind === "hold") callbacks.current.onHoldCancel();
    gesture.current = null;
  };

  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (alive) setReduceMotion(value);
    });
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => {
      alive = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (!props.recording || reduceMotion) {
      pulse.setValue(1);
      return;
    }
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.35, duration: 650, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 650, useNativeDriver: true }),
      ]),
    );
    animation.start();
    return () => {
      animation.stop();
      pulse.setValue(1);
    };
  }, [props.recording, reduceMotion, pulse]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (gesture.current?.kind === "hold") callbacks.current.onHoldCancel();
      gesture.current = null;
    },
    [props.enabled],
  );

  const grant = (event: GestureResponderEvent) => {
    cancel();
    const { pageX: x, pageY: y } = event.nativeEvent;
    const entry: Gesture = { x, y, kind: "press" };
    gesture.current = entry;
    timer.current = setTimeout(() => {
      timer.current = null;
      if (gesture.current !== entry || entry.kind !== "press") return;
      entry.kind = "hold";
      if (callbacks.current.enabled) callbacks.current.onHoldStart();
    }, 450);
  };

  const move = (event: GestureResponderEvent) => {
    const entry = gesture.current;
    if (!entry || entry.kind === "swiped") return;
    const dx = Math.abs(event.nativeEvent.pageX - entry.x);
    const dy = event.nativeEvent.pageY - entry.y;
    if (Math.max(dx, Math.abs(dy)) <= 12) return;
    clearTimer();
    if (entry.kind === "hold") callbacks.current.onHoldCancel();
    entry.kind = "moved";
    if (dy >= 24 && dy > dx) {
      entry.kind = "swiped";
      callbacks.current.onOpenPanel();
    }
  };

  const release = () => {
    clearTimer();
    const entry = gesture.current;
    gesture.current = null;
    if (entry?.kind === "hold" && props.enabled) props.onHoldEnd();
    else if (entry?.kind === "press") props.onToggle();
  };

  const color = props.recording
    ? "#53D8E9"
    : props.tone === "error"
      ? colors.danger
      : !props.enabled
        ? colors.textFaint
        : props.tone === "disconnected"
          ? colors.warning
          : props.tone === "working"
            ? colors.warning
            : props.tone === "done"
              ? colors.success
              : colors.accent;
  const status = props.recording
    ? "Listening"
    : `${props.enabled ? "Selection on" : "Selection off"}, ${props.tone}`;

  return (
    <View
      testID="inspector-indicator"
      style={[styles.target, { top: props.top }]}
      onStartShouldSetResponder={() => true}
      onResponderGrant={grant}
      onResponderMove={move}
      onResponderRelease={release}
      onResponderTerminate={cancel}
      onResponderTerminationRequest={() => true}
      accessible
      accessibilityRole="switch"
      accessibilityLabel="AI inspector selection"
      accessibilityState={{ checked: props.enabled }}
      accessibilityValue={{ text: status }}
      accessibilityHint="Tap to toggle selection. When enabled, hold to dictate. Pull down for controls."
      accessibilityActions={[
        { name: "activate", label: "Toggle selection" },
        { name: "voice", label: props.recording ? "Stop dictation" : "Start dictation" },
        { name: "controls", label: "Open inspector controls" },
      ]}
      onAccessibilityAction={({ nativeEvent }) => {
        if (nativeEvent.actionName === "activate") {
          cancel();
          props.onToggle();
        }
        if (nativeEvent.actionName === "controls") {
          cancel();
          props.onOpenPanel();
        }
        if (nativeEvent.actionName === "voice" && props.enabled) {
          if (props.recording) {
            gesture.current = null;
            props.onHoldEnd();
          } else {
            gesture.current = { x: 0, y: 0, kind: "hold" };
            props.onHoldStart();
          }
        }
      }}
    >
      <Animated.View
        testID="inspector-indicator-line"
        pointerEvents="none"
        style={[
          styles.line,
          {
            width: props.enabled ? 96 : 64,
            height: props.recording ? 6 : 4,
            backgroundColor: color,
            opacity: pulse,
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  target: {
    position: "absolute",
    alignSelf: "center",
    width: 112,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  line: { borderRadius: 3 },
});
