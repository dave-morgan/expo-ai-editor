import { Text, type TextProps } from "react-native";
import { palette, typeScale, type TypeVariant } from "./theme";

type Props = TextProps & { variant?: TypeVariant; tone?: "default" | "muted" | "faint" | "brand" | "inverse" };

const toneColor = {
  default: palette.ink,
  muted: palette.inkMuted,
  faint: palette.inkFaint,
  brand: palette.brand,
  inverse: "#FFFFFF",
} as const;

/** Design-system text: every heading and paragraph in the example goes through this component. */
export function AppText({ variant = "body", tone = "default", style, ...rest }: Props) {
  return <Text {...rest} style={[typeScale[variant], { color: toneColor[tone] }, style]} />;
}
