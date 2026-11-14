import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AIInspector } from "../src/AIInspector";
import { Indicator } from "../src/ui/Indicator";

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  cancel: vi.fn(),
  hitTest: vi.fn(),
  onFinal: (_text: string) => {},
  appState: { listener: (_state: string) => {} },
  selection: {
    elementType: "Text",
    componentName: "Heading",
    bounds: { x: 10, y: 80, width: 150, height: 40 },
    confidence: "high",
    confidenceNotes: [],
    hierarchy: [],
  },
}));
vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  Platform: {
    OS: "android",
    Version: 36,
    select: (values: { default: unknown }) => values.default,
  },
  StatusBar: { currentHeight: 24 },
  NativeModules: {},
  PixelRatio: { get: () => 1 },
  Dimensions: { get: () => ({ width: 400, height: 800 }) },
  useWindowDimensions: () => ({ width: 400, height: 800 }),
  StyleSheet: {
    create: (value: unknown) => value,
    flatten: (value: unknown) => value,
    absoluteFill: {},
  },
  Keyboard: { addListener: () => ({ remove() {} }), dismiss() {} },
  AppState: {
    currentState: "active",
    addEventListener: (_event: string, listener: (state: string) => void) => {
      mocks.appState.listener = listener;
      return { remove() {} };
    },
  },
  AccessibilityInfo: {
    isReduceMotionEnabled: async () => true,
    addEventListener: () => ({ remove() {} }),
  },
  Animated: {
    View: "AnimatedView",
    Value: class {
      setValue() {}
    },
  },
}));
vi.mock("../src/platform/optional", () => ({
  optional: { constants: () => null, router: () => null, safeArea: () => null },
}));
vi.mock("../src/bridge/client", () => ({
  BridgeClient: class {
    on() {
      return () => {};
    }
    async start() {}
    stop() {}
  },
  probeBridge: vi.fn(),
}));
vi.mock("../src/platform/token-store", () => ({ createTokenStore: () => ({}) }));
vi.mock("../src/platform/screenshot", () => ({
  screenshotsSupported: () => false,
  captureAppScreenshot: vi.fn(),
}));
vi.mock("../src/platform/refresh-observer", () => ({
  observeRefresh: () => ({ supported: false, unsubscribe() {} }),
}));
vi.mock("../src/platform/speech", () => ({
  useSpeechInput: (options: { onFinal: (text: string) => void }) => {
    mocks.onFinal = options.onFinal;
    return {
      status: "idle",
      start: mocks.start,
      stop: mocks.stop,
      cancel: mocks.cancel,
      support: { ok: true },
    };
  },
}));
vi.mock("../src/inspection/hit-test", () => ({ hitTest: mocks.hitTest }));
vi.mock("../src/inspection/metadata", () => ({ buildSelection: () => mocks.selection }));
vi.mock("../src/ui/Panel", () => ({
  Panel: ({ c }: { c: unknown }) => React.createElement("View", { testID: "inspector-panel", c }),
}));

let renderer: ReactTestRenderer;
const indicator = () => renderer.root.findByType(Indicator);
const selectionLayers = () => renderer.root.findAllByProps({ testID: "inspector-selection-layer" });
const panels = () => renderer.root.findAllByProps({ testID: "inspector-panel" });
beforeEach(async () => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.hitTest.mockResolvedValue({
    fiber: {},
    bounds: mocks.selection.bounds,
    strategy: "geometry",
  });
  await act(async () => {
    renderer = create(
      <AIInspector bridgeUrl="http://localhost:8790" dangerouslyEnableInProduction />,
    );
  });
});
afterEach(async () => {
  await act(async () => renderer.unmount());
});

it("leaves app touches free until the line enables selection", async () => {
  expect(selectionLayers()).toHaveLength(0);
  expect(panels()).toHaveLength(0);
  expect(indicator().props.top).toBe(24);
  act(() => indicator().props.onToggle());
  expect(selectionLayers()).toHaveLength(1);
  await act(async () =>
    selectionLayers()[0]!.props.onPress({ nativeEvent: { pageX: 40, pageY: 90 } }),
  );
  expect(mocks.hitTest).toHaveBeenCalledWith(null, 40, 90);
  expect(indicator().props.enabled).toBe(true);
  expect(panels()).toHaveLength(0);
  expect(selectionLayers()).toHaveLength(1);
  act(() => indicator().props.onToggle());
  expect(selectionLayers()).toHaveLength(0);
});

it("keeps selection enabled when the controls open and close", () => {
  act(() => indicator().props.onToggle());
  act(() => indicator().props.onOpenPanel());
  expect(panels()).toHaveLength(1);
  expect(selectionLayers()).toHaveLength(0);
  act(() => panels()[0]!.props.c.close());
  expect(panels()).toHaveLength(0);
  expect(selectionLayers()).toHaveLength(1);
});

it("records only when enabled and stops on release or background", () => {
  act(() => indicator().props.onHoldStart());
  expect(mocks.start).not.toHaveBeenCalled();
  act(() => indicator().props.onToggle());
  act(() => indicator().props.onHoldStart());
  expect(mocks.start).toHaveBeenCalledOnce();
  act(() => indicator().props.onHoldEnd());
  expect(mocks.stop).toHaveBeenCalledOnce();
  act(() => mocks.appState.listener("background"));
  expect(mocks.cancel).toHaveBeenCalled();
});

it("keeps the final voice transcript for review without sending automatically", () => {
  act(() => indicator().props.onToggle());
  act(() => indicator().props.onHoldStart());
  act(() => indicator().props.onHoldEnd());
  act(() => mocks.onFinal("Make this heading smaller"));
  expect(panels()).toHaveLength(1);
  expect(panels()[0]!.props.c.state).toMatchObject({
    selectionEnabled: true,
    transcript: "Make this heading smaller",
    activeRequestId: null,
  });
});

it("ignores a stale hit even when selection is switched off and back on", async () => {
  let finish = (_hit: unknown) => {};
  mocks.hitTest.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  act(() => indicator().props.onToggle());
  act(() => selectionLayers()[0]!.props.onPress({ nativeEvent: { pageX: 40, pageY: 90 } }));
  act(() => indicator().props.onToggle());
  act(() => indicator().props.onToggle());
  await act(async () =>
    finish({ fiber: {}, bounds: mocks.selection.bounds, strategy: "geometry" }),
  );
  act(() => indicator().props.onOpenPanel());
  expect(panels()[0]!.props.c.state.selection).toBeNull();
});

it("cancels a pending indicator hold when backgrounded and does not revive it on resume", () => {
  vi.useFakeTimers();
  try {
    act(() => indicator().props.onToggle());
    const target = renderer.root.findByProps({ testID: "inspector-indicator" });
    act(() => target.props.onResponderGrant({ nativeEvent: { pageX: 50, pageY: 30 } }));
    act(() => mocks.appState.listener("background"));
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(mocks.start).not.toHaveBeenCalled();
    act(() => mocks.appState.listener("active"));
    act(() => {
      vi.advanceTimersByTime(600);
      target.props.onResponderRelease();
    });
    expect(mocks.start).not.toHaveBeenCalled();
    expect(indicator().props.enabled).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
