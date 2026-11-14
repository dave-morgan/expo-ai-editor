import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSpeechInput } from "../src/platform/speech";

const native = vi.hoisted(() => ({
  events: new Map<string, (event?: unknown) => void>(),
  isRecognitionAvailable: () => true,
  supportsOnDeviceRecognition: () => true,
  getSupportedLocales: async () => ({ locales: ["en-AU"], installedLocales: ["en-AU"] }),
  requestPermissionsAsync: vi.fn(),
  getPermissionsAsync: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  abort: vi.fn(),
}));
vi.mock("../src/platform/optional", () => ({
  optional: {
    speech: () => ({
      ExpoSpeechRecognitionModule: native,
      useSpeechRecognitionEvent(name: string, listener: (event?: unknown) => void) {
        native.events.set(name, listener);
      },
    }),
  },
}));

let renderer: ReactTestRenderer;
let speech: ReturnType<typeof useSpeechInput>;
function Harness() {
  speech = useSpeechInput({ locale: "en-AU", requireOnDevice: true }, "android");
  return null;
}
async function mount() {
  await act(async () => {
    renderer = create(<Harness />);
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  native.getPermissionsAsync.mockResolvedValue({ granted: false });
  native.events.clear();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
});

it("does not start recording after release while permissions are pending", async () => {
  let grant = () => {};
  native.requestPermissionsAsync.mockImplementation(
    () =>
      new Promise((resolve) => {
        grant = () => resolve({ granted: true });
      }),
  );
  await mount();
  await act(async () => {
    void speech.start();
  });
  act(() => speech.stop());
  await act(async () => grant());
  expect(native.start).not.toHaveBeenCalled();
  expect(speech.status).toBe("idle");
});

it("does not start after unmount with permissions pending", async () => {
  let grant = () => {};
  native.requestPermissionsAsync.mockImplementation(
    () =>
      new Promise((resolve) => {
        grant = () => resolve({ granted: true });
      }),
  );
  await mount();
  await act(async () => {
    void speech.start();
  });
  await act(async () => renderer.unmount());
  await act(async () => grant());
  expect(native.start).not.toHaveBeenCalled();
});

it("starts and stops a permitted hold", async () => {
  native.requestPermissionsAsync.mockResolvedValue({ granted: true });
  await mount();
  await act(async () => {
    await speech.start();
  });
  expect(native.start).toHaveBeenCalledOnce();
  act(() => speech.stop());
  expect(native.stop).toHaveBeenCalledOnce();
});

it("does not reopen the Android permission activity when permission is already granted", async () => {
  native.getPermissionsAsync.mockResolvedValue({ granted: true });
  native.requestPermissionsAsync.mockRejectedValue(new Error("Already permitted"));
  await mount();
  await act(async () => { await speech.start(); });
  expect(native.start).toHaveBeenCalledOnce();
  expect(native.requestPermissionsAsync).not.toHaveBeenCalled();
});

it("aborts a delayed native start after the finger was released", async () => {
  native.requestPermissionsAsync.mockResolvedValue({ granted: true });
  await mount();
  await act(async () => {
    await speech.start();
  });
  act(() => speech.stop());
  act(() => native.events.get("end")?.());
  act(() => native.events.get("start")?.());
  expect(native.abort).toHaveBeenCalledOnce();
  expect(speech.status).not.toBe("listening");
});

it("waits for native cancellation to end before starting another session", async () => {
  native.requestPermissionsAsync.mockResolvedValue({ granted: true });
  await mount();
  await act(async () => {
    await speech.start();
  });
  act(() => speech.cancel());
  act(() =>
    native.events.get("error")?.({ error: "aborted", message: "Speech recognition aborted." }),
  );
  await act(async () => {
    await speech.start();
  });
  expect(native.start).toHaveBeenCalledTimes(1);
  act(() => native.events.get("end")?.());
  await act(async () => {
    await speech.start();
  });
  expect(native.start).toHaveBeenCalledTimes(2);
  act(() => speech.stop());
  expect(native.stop).toHaveBeenCalledOnce();
});
