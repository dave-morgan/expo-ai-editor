import React from "react";
import { Pressable, StyleSheet, Text, View, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import { colors, radius, space } from "./theme";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  label,
  variant = "secondary",
  disabled,
  style,
  compact,
  ...rest
}: Omit<PressableProps, "style" | "children"> & {
  label: string;
  variant?: ButtonVariant;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      hitSlop={6}
      style={({ pressed }) => [
        styles.button,
        compact && styles.buttonCompact,
        variantStyles[variant],
        pressed && !disabled && pressedStyles[variant],
        disabled && styles.disabled,
        style,
      ]}
      {...rest}
    >
      <Text style={[styles.buttonLabel, variant === "primary" && styles.primaryLabel, variant === "danger" && styles.dangerLabel]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

export function IconButton({
  glyph,
  label,
  onPress,
  active,
  size = 36,
}: {
  glyph: string;
  label: string;
  onPress: () => void;
  active?: boolean;
  size?: number;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [
        styles.icon,
        { width: size, height: size, borderRadius: size / 2 },
        active && styles.iconActive,
        pressed && styles.iconPressed,
      ]}
    >
      <Text style={[styles.iconGlyph, active && { color: colors.text }]}>{glyph}</Text>
    </Pressable>
  );
}

export function StatusDot({ color, pulse }: { color: string; pulse?: boolean }) {
  return <View style={[styles.dot, { backgroundColor: color }, pulse && { shadowColor: color, shadowOpacity: 0.9, shadowRadius: 4 }]} />;
}

export function Badge({ label, tone = "neutral" }: { label: string; tone?: "neutral" | "good" | "warn" | "bad" | "accent" }) {
  const toneStyle = badgeTones[tone];
  return (
    <View style={[styles.badge, { backgroundColor: toneStyle.bg }]}>
      <Text style={[styles.badgeText, { color: toneStyle.fg }]}>{label}</Text>
    </View>
  );
}

const badgeTones = {
  neutral: { bg: "rgba(255,255,255,0.08)", fg: colors.textMuted },
  good: { bg: "rgba(61,214,140,0.15)", fg: colors.success },
  warn: { bg: "rgba(245,184,65,0.15)", fg: colors.warning },
  bad: { bg: colors.dangerSoft, fg: colors.danger },
  accent: { bg: colors.accentSoft, fg: "#B9AFFF" },
};

const variantStyles = StyleSheet.create({
  primary: { backgroundColor: colors.accent, borderColor: colors.accent },
  secondary: { backgroundColor: colors.surfaceRaised, borderColor: colors.borderStrong },
  ghost: { backgroundColor: "transparent", borderColor: "transparent" },
  danger: { backgroundColor: colors.dangerSoft, borderColor: "transparent" },
});

const pressedStyles = StyleSheet.create({
  primary: { backgroundColor: colors.accentPressed },
  secondary: { backgroundColor: "#262B36" },
  ghost: { backgroundColor: "rgba(255,255,255,0.06)" },
  danger: { backgroundColor: "rgba(255,107,107,0.24)" },
});

const styles = StyleSheet.create({
  button: {
    minHeight: 40,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonCompact: { minHeight: 32, paddingHorizontal: space.md, borderRadius: radius.sm },
  buttonLabel: { color: colors.text, fontSize: 14, fontWeight: "600" },
  primaryLabel: { color: "#FFFFFF" },
  dangerLabel: { color: colors.danger },
  disabled: { opacity: 0.4 },
  icon: { alignItems: "center", justifyContent: "center", backgroundColor: "transparent" },
  iconActive: { backgroundColor: colors.accentSoft },
  iconPressed: { backgroundColor: "rgba(255,255,255,0.08)" },
  iconGlyph: { color: colors.textMuted, fontSize: 17, fontWeight: "600" },
  dot: { width: 8, height: 8, borderRadius: 4 },
  badge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: radius.pill },
  badgeText: { fontSize: 11, fontWeight: "700", letterSpacing: 0.2 },
});
