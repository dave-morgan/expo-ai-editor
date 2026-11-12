import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { AIInspector } from "expo-ai-inspector";
import { palette } from "../src/ui/theme";

export default function RootLayout() {
  return (
    <>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: palette.background },
          headerShadowVisible: false,
          headerTintColor: palette.ink,
          contentStyle: { backgroundColor: palette.background },
        }}
      >
        <Stack.Screen name="index" options={{ title: "Home" }} />
        <Stack.Screen name="profile" options={{ title: "Profile" }} />
        <Stack.Screen name="settings" options={{ title: "Settings" }} />
      </Stack>
      {__DEV__ && <AIInspector />}
    </>
  );
}
