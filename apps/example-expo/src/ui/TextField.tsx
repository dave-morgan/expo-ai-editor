import { StyleSheet, TextInput, View, type TextInputProps } from "react-native";
import { AppText } from "./AppText";
import { palette, radii, spacing } from "./theme";

type Props = TextInputProps & { label: string; hint?: string };

export function TextField({ label, hint, style, ...rest }: Props) {
  return (
    <View style={styles.wrap}>
      <AppText variant="overline" tone="muted">
        {label}
      </AppText>
      <TextInput placeholderTextColor={palette.inkFaint} {...rest} style={[styles.input, style]} />
      {hint ? (
        <AppText variant="caption" tone="faint">
          {hint}
        </AppText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.xs },
  input: {
    height: 48,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.line,
    backgroundColor: palette.surface,
    paddingHorizontal: spacing.md,
    fontSize: 16,
    color: palette.ink,
  },
});
