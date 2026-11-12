export const palette = {
  background: "#F6F5F2",
  surface: "#FFFFFF",
  ink: "#16181D",
  inkMuted: "#5D6472",
  inkFaint: "#9AA0AB",
  line: "#E6E3DD",
  brand: "#1F6F5C",
  brandSoft: "#E3F1EC",
  accent: "#E9883D",
  danger: "#C2412D",
} as const;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radii = { sm: 8, md: 12, lg: 20, pill: 999 } as const;

export const typeScale = {
  display: { fontSize: 32, lineHeight: 38, fontWeight: "700" as const, letterSpacing: -0.6 },
  title: { fontSize: 22, lineHeight: 28, fontWeight: "700" as const, letterSpacing: -0.3 },
  subtitle: { fontSize: 17, lineHeight: 22, fontWeight: "600" as const },
  body: { fontSize: 15, lineHeight: 22, fontWeight: "400" as const },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: "400" as const },
  overline: { fontSize: 11, lineHeight: 14, fontWeight: "700" as const, letterSpacing: 1.2, textTransform: "uppercase" as const },
};

export type TypeVariant = keyof typeof typeScale;
