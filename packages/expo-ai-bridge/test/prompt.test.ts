import { FeedbackSchema } from "@dave-morgan/expo-ai-protocol";
import { describe, expect, it } from "vitest";
import { buildAgentPrompt } from "../src/prompt.js";

const base = {
  requestId: "request_123",
  projectId: "app",
  instruction: "Make this smaller",
  inputMethod: "voice",
  createdAt: "2026-01-01T00:00:00Z",
};
const project = { id: "app", name: "App", root: "/app", t3Project: "t3-id" };
describe("agent prompt", () => {
  it("renders real source, device, hierarchy and screenshot details", () => {
    const feedback = FeedbackSchema.parse({
      ...base,
      selection: {
        elementType: "Text",
        componentName: "Header",
        source: { file: "src/Header.tsx", line: 42, column: 6 },
        componentSource: { file: "src/Header.tsx", line: 12 },
        sourceOrigin: "babel-transform",
        confidence: "high",
        screen: "/profile",
        visibleText: "Welcome",
        testID: "title",
        accessibilityLabel: "Greeting",
        hierarchy: [{ name: "Header" }, { name: "Stack", isLibrary: true }],
        bounds: { x: 24, y: 120, width: 280, height: 40 },
        style: { fontSize: 28, fontWeight: "700", color: null },
      },
    });
    const prompt = buildAgentPrompt({
      feedback,
      project,
      appRootRelative: "apps/app",
      screenshotPath: ".expo-ai/screenshots/request_123.jpg",
      device: { platform: "ios", osVersion: "18.2", windowWidth: 393, windowHeight: 852 },
    });
    for (const text of [
      "voice, transcribed on device",
      "src/Header.tsx:42:6",
      "defined at src/Header.tsx:12",
      "Header › Stack [lib]",
      "393×852",
      "fontSize 28",
      'fontWeight "700"',
      "confidence high (babel-transform)",
      ".expo-ai/screenshots/request_123.jpg",
      "Edit the source files",
    ])
      expect(prompt).toContain(text);
    expect(prompt).not.toMatch(/undefined|null/);
  });
  it.each(["low", "none"])("handles %s confidence without fabricated source data", (confidence) => {
    const feedback = FeedbackSchema.parse({
      ...base,
      inputMethod: "typed",
      selection: {
        elementType: "View",
        sourceOrigin: "none",
        confidence,
        bounds: { x: 0, y: 0, width: 1, height: 1 },
      },
    });
    const prompt = buildAgentPrompt({ feedback, project });
    expect(prompt).toContain("Instruction (typed)");
    expect(prompt).toContain("Source location could not be determined reliably");
    expect(prompt).not.toContain("Source (JSX call site)");
    expect(prompt).not.toMatch(/undefined|null/);
  });
  it("handles no selection and voice edits", () => {
    const prompt = buildAgentPrompt({
      feedback: FeedbackSchema.parse({ ...base, inputMethod: "voice-edited" }),
      project,
    });
    expect(prompt).toContain("No element selected.");
    expect(prompt).toContain("voice, edited by the developer");
    expect(prompt).not.toMatch(/undefined|null/);
  });
});
