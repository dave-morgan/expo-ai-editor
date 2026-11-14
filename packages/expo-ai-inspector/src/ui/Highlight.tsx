import type { Bounds } from "@dave-morgan/expo-ai-protocol";
import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors, mono, radius } from "./theme";

/** Outline drawn over the selected element, with a compact name tag placed outside the box. */
export function Highlight({
  bounds,
  title,
  subtitle,
  window,
}: {
  bounds: Bounds;
  title: string;
  subtitle?: string;
  window: { width: number; height: number };
}) {
  const tagAbove = bounds.y > 44;
  const tagTop = tagAbove ? bounds.y - 28 : Math.min(bounds.y + bounds.height + 4, window.height - 28);
  const tagLeft = Math.max(4, Math.min(bounds.x, window.width - 220));
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View
        style={[
          styles.box,
          { left: bounds.x - 2, top: bounds.y - 2, width: bounds.width + 4, height: bounds.height + 4 },
        ]}
      />
      <View style={[styles.tag, { top: tagTop, left: tagLeft }]}>
        <Text style={styles.tagTitle} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.tagSubtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
        <Text style={styles.tagSize}>
          {Math.round(bounds.width)}×{Math.round(bounds.height)}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    position: "absolute",
    borderWidth: 2,
    borderColor: colors.highlight,
    backgroundColor: colors.highlightFill,
    borderRadius: 4,
  },
  tag: {
    position: "absolute",
    maxWidth: 260,
    height: 24,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 8,
    borderRadius: radius.sm,
    backgroundColor: colors.highlight,
  },
  tagTitle: { color: "#fff", fontSize: 12, fontWeight: "700", flexShrink: 1 },
  tagSubtitle: { color: "rgba(255,255,255,0.8)", fontSize: 11, fontFamily: mono, flexShrink: 2 },
  tagSize: { color: "rgba(255,255,255,0.7)", fontSize: 11, fontFamily: mono },
});
