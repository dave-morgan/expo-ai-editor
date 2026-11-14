import type { DeviceInfo, Feedback, SourceLocation } from "@dave-morgan/expo-ai-protocol";
import type { BridgeProject } from "./config.js";

interface PromptInput {
  feedback: Feedback;
  project: BridgeProject;
  screenshotPath?: string;
  appRootRelative?: string;
  capabilitiesNote?: string;
  device?: DeviceInfo;
}
function location(source: SourceLocation) {
  return `${source.file}:${source.line}${source.column !== undefined ? `:${source.column}` : ""}`;
}

export function buildAgentPrompt({
  feedback,
  screenshotPath,
  appRootRelative,
  capabilitiesNote,
  device,
}: PromptInput) {
  const method = {
    voice: "voice, transcribed on device",
    typed: "typed",
    "voice-edited": "voice, edited by the developer",
  }[feedback.inputMethod];
  const lines = [
    "[Expo AI Inspector] Visual change request from the running app.",
    "",
    `Instruction (${method}):`,
    JSON.stringify(feedback.instruction),
    "",
  ];
  const selection = feedback.selection;
  if (!selection) lines.push("No element selected.");
  else {
    lines.push("Selected element");
    if (appRootRelative)
      lines.push(`- App root: ${appRootRelative} (file paths below are relative to it)`);
    const screen = [
      selection.screen,
      device ? [device.platform, device.osVersion].filter(Boolean).join(" ") : undefined,
      device?.windowWidth !== undefined && device.windowHeight !== undefined
        ? `window ${device.windowWidth}×${device.windowHeight}`
        : undefined,
    ].filter(Boolean);
    if (screen.length) lines.push(`- Screen: ${screen.join(" · ")}`);
    lines.push(
      `- Element: <${selection.elementType}>${selection.visibleText ? ` ${JSON.stringify(selection.visibleText)}` : ""}`,
    );
    if (selection.source)
      lines.push(
        `- Source (JSX call site): ${location(selection.source)} — confidence ${selection.confidence} (${selection.sourceOrigin})`,
      );
    if (selection.componentName)
      lines.push(
        `- Component: ${selection.componentName}${selection.componentSource ? ` (defined at ${location(selection.componentSource)})` : ""}`,
      );
    if (selection.hierarchy.length)
      lines.push(
        `- Component stack: ${selection.hierarchy.map((frame) => `${frame.name}${frame.isLibrary ? " [lib]" : ""}`).join(" › ")} (innermost first, library frames marked [lib])`,
      );
    const identifiers = [
      selection.testID ? `testID: ${selection.testID}` : undefined,
      selection.accessibilityLabel
        ? `accessibility label: ${JSON.stringify(selection.accessibilityLabel)}`
        : undefined,
      selection.accessibilityRole
        ? `accessibility role: ${selection.accessibilityRole}`
        : undefined,
      selection.nativeID ? `nativeID: ${selection.nativeID}` : undefined,
    ].filter(Boolean);
    if (identifiers.length) lines.push(`- ${identifiers.join(" · ")}`);
    const { x, y, width, height } = selection.bounds;
    lines.push(`- Bounds: x ${x}, y ${y}, ${width}×${height} dp`);
    const style = Object.entries(selection.style ?? {})
      .filter(([, value]) => value !== null)
      .map(([key, value]) => `${key} ${JSON.stringify(value)}`);
    if (style.length) lines.push(`- Style: ${style.join(", ")}`);
    if (selection.confidenceNotes.length)
      lines.push(`- Confidence notes: ${selection.confidenceNotes.join("; ")}`);
    if (selection.confidence === "low" || selection.confidence === "none")
      lines.push(
        "Source location could not be determined reliably; locate the element using the details above.",
      );
  }
  if (screenshotPath) lines.push(`- Screenshot: ${screenshotPath} (relative to app root)`);
  if (capabilitiesNote) lines.push(capabilitiesNote);
  lines.push(
    "",
    "Edit the source files to implement this change — do not just describe it. Keep the change scoped to the selected element unless the instruction says otherwise. Expo Fast Refresh will pick up saved files.",
  );
  return lines.join("\n");
}
