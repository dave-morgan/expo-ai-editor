import { Pressable, StyleSheet, type PressableProps } from "react-native";
import { AppText } from "./AppText";
import { palette, radii, spacing } from "./theme";

type Props = Omit<PressableProps, "children"> & { label: string; variant?: "primary" | "secondary" | "danger" };

export function Button({ label, variant = "primary", style, ...rest }: Props) {
  return (
    <Pressable
      accessibilityRole="button"
      style={(state) => [
        styles.base,
        styles[variant],
        state.pressed && styles.pressed,
        typeof style === "function" ? style(state) : style,
      ]}
      {...rest}
    >
      <AppText variant="subtitle" tone={variant === "secondary" ? "default" : "inverse"} style={styles.label}>
        {label}
      </AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    height: 50,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.xl,
  },
  primary: { backgroundColor: palette.brand },
  secondary: { backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line },
  danger: { backgroundColor: palette.danger },
  pressed: { opacity: 0.85 },
  label: { fontSize: 16 },
});
