import { StyleSheet, Switch, View } from "react-native";
import { AppText } from "../ui/AppText";
import { palette, spacing } from "../ui/theme";

type Props = { title: string; description: string; value: boolean; onChange: (value: boolean) => void };

export function SettingsRow({ title, description, value, onChange }: Props) {
  return (
    <View style={styles.row}>
      <View style={styles.text}>
        <AppText variant="subtitle">{title}</AppText>
        <AppText variant="caption" tone="muted">
          {description}
        </AppText>
      </View>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: palette.brand, false: palette.line }} accessibilityLabel={title} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.sm },
  text: { flex: 1, gap: 2 },
});
