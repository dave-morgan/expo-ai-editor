import type { Screenshot } from "@dave-morgan/expo-ai-protocol";
import { optional } from "./optional";

export function screenshotsSupported(): boolean {
  return optional.viewShot() !== null;
}

/**
 * Captures the app window as a compact JPEG (the caller hides the inspector overlay first).
 * Resized to at most `maxWidth` pixels wide to keep the payload small.
 */
export async function captureAppScreenshot(
  window: { width: number; height: number },
  maxWidth = 720,
): Promise<Screenshot | null> {
  const viewShot = optional.viewShot();
  if (!viewShot) return null;
  const width = Math.round(Math.min(maxWidth, window.width * 2));
  const height = Math.round((width / window.width) * window.height);
  const base64 = await viewShot.captureScreen({ format: "jpg", quality: 0.6, result: "base64", width, height });
  const clean = base64.replace(/^data:image\/\w+;base64,/, "").replace(/\s/g, "");
  if (!clean) return null;
  return { mimeType: "image/jpeg", base64: clean, width, height, scale: width / window.width };
}
