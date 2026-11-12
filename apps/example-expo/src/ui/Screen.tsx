import type { ReactNode } from "react";
import { ScrollView, StyleSheet } from "react-native";
import { palette, spacing } from "./theme";

export function Screen({ children, testID }: { children: ReactNode; testID?: string }) {
  return (
    <ScrollView testID={testID} style={styles.scroll} contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
      {children}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: palette.background },
  content: { padding: spacing.lg, gap: spacing.lg, paddingBottom: 140 },
});
