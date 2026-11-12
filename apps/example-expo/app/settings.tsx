import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { SettingsRow } from "../src/components/SettingsRow";
import { AppText } from "../src/ui/AppText";
import { Button } from "../src/ui/Button";
import { Card } from "../src/ui/Card";
import { Screen } from "../src/ui/Screen";
import { TextField } from "../src/ui/TextField";
import { spacing } from "../src/ui/theme";

export default function SettingsScreen() {
  const [name, setName] = useState("Alex Morgan");
  const [email, setEmail] = useState("alex@example.com");
  const [notifications, setNotifications] = useState(true);
  const [weekly, setWeekly] = useState(false);

  return (
    <Screen testID="settings-screen">
      <AppText variant="title">Account</AppText>
      <Card style={styles.form}>
        <TextField label="Display name" value={name} onChangeText={setName} autoCapitalize="words" />
        <TextField
          label="Email"
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          autoCapitalize="none"
          hint="Used for receipts and account recovery."
        />
      </Card>

      <AppText variant="title">Notifications</AppText>
      <Card>
        <SettingsRow title="Push notifications" description="Activity from people you follow" value={notifications} onChange={setNotifications} />
        <SettingsRow title="Weekly summary" description="A Monday morning recap email" value={weekly} onChange={setWeekly} />
      </Card>

      <View style={styles.actions}>
        <Button label="Save changes" />
        <Button label="Sign out" variant="danger" />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  form: { gap: spacing.lg },
  actions: { gap: spacing.md },
});
