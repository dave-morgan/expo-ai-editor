import { Platform } from "react-native";

/** Fixed dark palette so the overlay reads clearly on top of any host app theme. */
export const colors = {
  surface: "rgba(16, 18, 24, 0.97)",
  surfaceRaised: "#1C2029",
  surfaceSunken: "#0C0E12",
  border: "rgba(255, 255, 255, 0.08)",
  borderStrong: "rgba(255, 255, 255, 0.16)",
  text: "#F2F4F8",
  textMuted: "#9AA3B2",
  textFaint: "#636B7A",
  accent: "#7C6CFF",
  accentPressed: "#6A59F0",
  accentSoft: "rgba(124, 108, 255, 0.16)",
  highlight: "#7C6CFF",
  highlightFill: "rgba(124, 108, 255, 0.14)",
  success: "#3DD68C",
  warning: "#F5B841",
  danger: "#FF6B6B",
  dangerSoft: "rgba(255, 107, 107, 0.14)",
  scrim: "rgba(8, 10, 14, 0.18)",
} as const;

export const radius = { sm: 6, md: 10, lg: 16, pill: 999 } as const;
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20 } as const;

export const mono = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

export const type = {
  title: { fontSize: 15, fontWeight: "600" as const, color: colors.text, letterSpacing: -0.2 },
  body: { fontSize: 14, color: colors.text, lineHeight: 20 },
  label: { fontSize: 11, fontWeight: "600" as const, color: colors.textMuted, letterSpacing: 0.6, textTransform: "uppercase" as const },
  caption: { fontSize: 12, color: colors.textMuted, lineHeight: 16 },
  code: { fontSize: 12, color: colors.text, fontFamily: mono },
};

export const shadow = Platform.select({
  ios: { shadowColor: "#000", shadowOpacity: 0.35, shadowRadius: 18, shadowOffset: { width: 0, height: 8 } },
  android: { elevation: 16 },
  default: { boxShadow: "0 8px 28px rgba(0,0,0,0.35)" },
});
