import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Indicator } from "../src/ui/Indicator";

const motion = vi.hoisted(() => ({ reduced: false, start: vi.fn(), stop: vi.fn(), loop: vi.fn() }));
vi.mock("react-native", () => ({
  View: "View",
  Platform: { select: () => ({}) },
  StyleSheet: { create: (value: unknown) => value },
  AccessibilityInfo: {
    isReduceMotionEnabled: async () => motion.reduced,
    addEventListener: () => ({ remove() {} }),
  },
  Animated: {
    View: "AnimatedView",
    Value: class {
      setValue() {}
    },
    timing: () => ({}),
    sequence: () => ({}),
    loop: () => {
      motion.loop();
      return { start: motion.start, stop: motion.stop };
    },
  },
}));

const event = (x = 0, y = 0) => ({ nativeEvent: { pageX: x, pageY: y } });
let renderer: ReactTestRenderer;
const callbacks = () => ({
  onToggle: vi.fn(),
  onHoldStart: vi.fn(),
  onHoldEnd: vi.fn(),
  onHoldCancel: vi.fn(),
  onOpenPanel: vi.fn(),
});
async function mount(enabled = true) {
  const handlers = callbacks();
  await act(async () => {
    renderer = create(
      <Indicator enabled={enabled} recording={false} tone="ready" top={0} {...handlers} />,
    );
  });
  return { ...handlers, target: renderer.root.findByProps({ testID: "inspector-indicator" }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  motion.reduced = false;
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
  vi.useRealTimers();
});

describe("indicator gestures", () => {
  it("toggles with a short tap", async () => {
    const c = await mount(false);
    act(() => {
      c.target.props.onResponderGrant(event());
      c.target.props.onResponderRelease();
    });
    expect(c.onToggle).toHaveBeenCalledOnce();
    expect(c.onHoldStart).not.toHaveBeenCalled();
  });
  it("holds to dictate and releases to stop, without toggling", async () => {
    const c = await mount();
    act(() => {
      c.target.props.onResponderGrant(event());
      vi.advanceTimersByTime(450);
    });
    expect(c.onHoldStart).toHaveBeenCalledOnce();
    act(() => c.target.props.onResponderRelease());
    expect(c.onHoldEnd).toHaveBeenCalledOnce();
    expect(c.onToggle).not.toHaveBeenCalled();
  });
  it("does not enable selection or record on an inactive hold", async () => {
    const c = await mount(false);
    act(() => {
      c.target.props.onResponderGrant(event());
      vi.advanceTimersByTime(600);
      c.target.props.onResponderRelease();
    });
    expect(c.onToggle).not.toHaveBeenCalled();
    expect(c.onHoldStart).not.toHaveBeenCalled();
  });
  it("pulls down to open controls without toggling or recording", async () => {
    const c = await mount(false);
    act(() => {
      c.target.props.onResponderGrant(event());
      c.target.props.onResponderMove(event(0, 28));
      vi.advanceTimersByTime(600);
      c.target.props.onResponderRelease();
    });
    expect(c.onOpenPanel).toHaveBeenCalledOnce();
    expect(c.onHoldStart).not.toHaveBeenCalled();
    expect(c.onToggle).not.toHaveBeenCalled();
  });
  it("cancels a hold timer when the finger moves sideways", async () => {
    const c = await mount();
    act(() => {
      c.target.props.onResponderGrant(event());
      c.target.props.onResponderMove(event(30, 0));
      vi.advanceTimersByTime(600);
      c.target.props.onResponderRelease();
    });
    expect(c.onHoldStart).not.toHaveBeenCalled();
    expect(c.onToggle).not.toHaveBeenCalled();
    expect(c.onOpenPanel).not.toHaveBeenCalled();
  });
  it("cancels recording on responder termination", async () => {
    const c = await mount();
    act(() => {
      c.target.props.onResponderGrant(event());
      vi.advanceTimersByTime(450);
      c.target.props.onResponderTerminate();
      c.target.props.onResponderRelease();
    });
    expect(c.onHoldCancel).toHaveBeenCalledOnce();
    expect(c.onHoldEnd).not.toHaveBeenCalled();
    expect(c.onToggle).not.toHaveBeenCalled();
  });
  it("cleans up recording and pending timers on unmount", async () => {
    const c = await mount();
    act(() => {
      c.target.props.onResponderGrant(event());
      vi.advanceTimersByTime(450);
      renderer.unmount();
      vi.advanceTimersByTime(600);
    });
    expect(c.onHoldCancel).toHaveBeenCalledOnce();
    expect(c.onHoldStart).toHaveBeenCalledOnce();
  });
  it("offers accessible toggle, voice, and controls actions", async () => {
    const c = await mount();
    expect(c.target.props.accessibilityState.checked).toBe(true);
    act(() => c.target.props.onAccessibilityAction({ nativeEvent: { actionName: "activate" } }));
    expect(c.onToggle).toHaveBeenCalledOnce();
    act(() => c.target.props.onAccessibilityAction({ nativeEvent: { actionName: "controls" } }));
    expect(c.onOpenPanel).toHaveBeenCalledOnce();
  });

  it("changes color and pulses while listening, then stops the animation", async () => {
    const c = await mount();
    await act(async () =>
      renderer.update(<Indicator enabled recording tone="ready" top={0} {...c} />),
    );
    expect(motion.start).toHaveBeenCalledOnce();
    const line = renderer.root.findByProps({ testID: "inspector-indicator-line" });
    expect(line.props.style[1]).toMatchObject({ backgroundColor: "#53D8E9", height: 6 });
    await act(async () =>
      renderer.update(<Indicator enabled recording={false} tone="ready" top={0} {...c} />),
    );
    expect(motion.stop).toHaveBeenCalledOnce();
  });

  it("keeps recording visible without pulsing when reduced motion is enabled", async () => {
    motion.reduced = true;
    const c = await mount();
    await act(async () =>
      renderer.update(<Indicator enabled recording tone="ready" top={0} {...c} />),
    );
    expect(motion.start).not.toHaveBeenCalled();
  });

  it("clears a pending hold when disabled or unmounted", async () => {
    const c = await mount();
    act(() => c.target.props.onResponderGrant(event()));
    await act(async () =>
      renderer.update(<Indicator enabled={false} recording={false} tone="ready" top={0} {...c} />),
    );
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(c.onHoldStart).not.toHaveBeenCalled();
    act(() => {
      c.target.props.onResponderGrant(event());
      renderer.unmount();
      vi.advanceTimersByTime(600);
    });
    expect(c.onHoldStart).not.toHaveBeenCalled();
  });
});
