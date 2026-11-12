import { StyleSheet, View } from "react-native";
import { AppText } from "../ui/AppText";
import { palette, spacing } from "../ui/theme";

export function ProfileHeader({ name, role }: { name: string; role: string }) {
  const initials = name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2);
  return (
    <View style={styles.container} testID="profile-header">
      <View style={styles.avatar}>
        <AppText variant="title" tone="inverse">
          {initials}
        </AppText>
      </View>
      <AppText variant="display" style={styles.greeting} accessibilityRole="header">
        Welcome back
      </AppText>
      <AppText variant="subtitle">{name}</AppText>
      <AppText variant="caption" tone="muted">
        {role}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: "center", paddingVertical: spacing.xl, gap: spacing.xs },
  avatar: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: palette.brand,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.md,
  },
  greeting: { marginBottom: spacing.md },
});
