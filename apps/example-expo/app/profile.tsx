import { StyleSheet, View } from "react-native";
import { ActivityList, type Activity } from "../src/components/ActivityList";
import { ProfileHeader } from "../src/components/ProfileHeader";
import { StatCard } from "../src/components/StatCard";
import { Button } from "../src/ui/Button";
import { Screen } from "../src/ui/Screen";
import { spacing } from "../src/ui/theme";

const activity: Activity[] = [
  { id: "1", title: "Completed a 5 km run", detail: "Centennial Park · 27:41", when: "2h" },
  { id: "2", title: "Joined Saturday Social", detail: "Bondi to Coogee coastal walk", when: "1d" },
  { id: "3", title: "New personal best", detail: "1 km split · 4:58", when: "3d" },
  { id: "4", title: "Shared a route", detail: "Harbour Bridge loop", when: "5d" },
];

export default function ProfileScreen() {
  return (
    <Screen testID="profile-screen">
      <ProfileHeader name="Alex Morgan" role="Product designer · Sydney" />
      <View style={styles.stats}>
        <StatCard label="This week" value="18.4 km" trend="+12% vs last week" />
        <StatCard label="Streak" value="9 days" />
      </View>
      <ActivityList items={activity} />
      <Button label="Edit profile" variant="secondary" />
    </Screen>
  );
}

const styles = StyleSheet.create({
  stats: { flexDirection: "row", gap: spacing.md, flexWrap: "wrap" },
});
