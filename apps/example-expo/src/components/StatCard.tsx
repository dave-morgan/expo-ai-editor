import { StyleSheet } from "react-native";
import { AppText } from "../ui/AppText";
import { Card } from "../ui/Card";
import { spacing } from "../ui/theme";

export function StatCard({ label, value, trend }: { label: string; value: string; trend?: string }) {
  return (
    <Card style={styles.card}>
      <AppText variant="overline" tone="muted">
        {label}
      </AppText>
      <AppText variant="title">{value}</AppText>
      {trend ? (
        <AppText variant="caption" tone="brand">
          {trend}
        </AppText>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { flex: 1, gap: spacing.xs, minWidth: 140 },
});
