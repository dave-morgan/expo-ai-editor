import { Link } from "expo-router";
import { Pressable, StyleSheet, View } from "react-native";
import { AppText } from "../src/ui/AppText";
import { Card } from "../src/ui/Card";
import { Screen } from "../src/ui/Screen";
import { palette, spacing } from "../src/ui/theme";

const destinations = [
  { href: "/profile" as const, title: "Profile", body: "Header, stat cards and an activity list built from shared components." },
  { href: "/settings" as const, title: "Settings", body: "A form with text fields, switches and buttons." },
];

export default function Home() {
  return (
    <Screen testID="home-screen">
      <View style={styles.hero}>
        <AppText variant="overline" tone="brand">
          Expo AI Inspector
        </AppText>
        <AppText variant="display">Try it on any element</AppText>
        <AppText tone="muted">
          Tap the purple button, select something on screen, then say what to change. The instruction goes to your T3 Code
          thread and Fast Refresh shows the result here.
        </AppText>
      </View>
      {destinations.map((destination) => (
        <Link key={destination.href} href={destination.href} asChild>
          <Pressable accessibilityRole="link">
            <Card style={styles.navCard}>
              <View style={styles.navText}>
                <AppText variant="subtitle">{destination.title}</AppText>
                <AppText variant="caption" tone="muted">
                  {destination.body}
                </AppText>
              </View>
              <AppText variant="title" tone="faint">
                ›
              </AppText>
            </Card>
          </Pressable>
        </Link>
      ))}
      <Card style={styles.tip}>
        <AppText variant="caption" tone="brand">
          Tip: hold on an element while selecting to start dictating immediately.
        </AppText>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { gap: spacing.sm, paddingVertical: spacing.lg },
  navCard: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  navText: { flex: 1, gap: spacing.xs },
  tip: { backgroundColor: palette.brandSoft, borderColor: palette.brandSoft },
});
