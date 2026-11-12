import { StyleSheet, View } from "react-native";
import { AppText } from "../ui/AppText";
import { Card } from "../ui/Card";
import { palette, spacing } from "../ui/theme";

export type Activity = { id: string; title: string; detail: string; when: string };

function ActivityRow({ item, last }: { item: Activity; last: boolean }) {
  return (
    <View style={[styles.row, !last && styles.divider]}>
      <View style={styles.dot} />
      <View style={styles.body}>
        <AppText variant="subtitle">{item.title}</AppText>
        <AppText variant="caption" tone="muted">
          {item.detail}
        </AppText>
      </View>
      <AppText variant="caption" tone="faint">
        {item.when}
      </AppText>
    </View>
  );
}

export function ActivityList({ items }: { items: Activity[] }) {
  return (
    <Card style={styles.card}>
      <AppText variant="overline" tone="muted" style={styles.heading}>
        Recent activity
      </AppText>
      {items.map((item, index) => (
        <ActivityRow key={item.id} item={item} last={index === items.length - 1} />
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { paddingVertical: spacing.sm },
  heading: { paddingVertical: spacing.sm },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.md },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.line },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: palette.accent },
  body: { flex: 1, gap: 2 },
});
