import { describe, expect, it, vi } from "vitest";
import { discoverBridgeUrl, hostFromHostUri } from "../src/bridge/discovery";
import { pickCandidate } from "../src/inspection/hit-test";
import { isCompileErrorMessage, observeRefresh } from "../src/platform/refresh-observer";
import { checkSpeechSupport, describeSpeechError } from "../src/platform/speech";

describe("pickCandidate", () => {
  const box = (index: number, x: number, y: number, w: number, h: number) => ({ index, depth: index, bounds: { x, y, width: w, height: h } });

  it("prefers descendants over ancestors", () => {
    expect(pickCandidate([box(0, 0, 0, 400, 800), box(1, 10, 10, 200, 50), box(2, 20, 20, 50, 20)], 30, 25)?.index).toBe(2);
  });
  it("prefers later siblings, which are drawn on top", () => {
    expect(pickCandidate([box(0, 0, 0, 400, 800), box(1, 0, 0, 100, 100), box(2, 0, 0, 100, 100)], 50, 50)?.index).toBe(2);
  });
  it("ignores zero-size and non-containing boxes", () => {
    expect(pickCandidate([box(0, 0, 0, 0, 0), box(1, 100, 100, 10, 10)], 5, 5)).toBeNull();
  });
});

describe("bridge discovery", () => {
  it("derives the bridge from the Metro host", () => {
    expect(discoverBridgeUrl({ hostUri: "192.168.1.20:8081" })).toBe("http://192.168.1.20:8790");
    expect(discoverBridgeUrl({ scriptURL: "http://10.0.2.2:8081/index.bundle?platform=android" })).toBe("http://10.0.2.2:8790");
    expect(discoverBridgeUrl({ webHostname: "localhost", port: 9000 })).toBe("http://localhost:9000");
    expect(discoverBridgeUrl({})).toBeNull();
  });
  it("handles IPv6 and schemes", () => {
    expect(hostFromHostUri("[::1]:8081")).toBe("[::1]");
    expect(hostFromHostUri("exp://host.local:8081/path")).toBe("host.local");
  });
});

describe("speech support", () => {
  const module = (overrides: Partial<{ available: boolean; onDevice: boolean; locales: string[]; installed: string[] }> = {}) => ({
    isRecognitionAvailable: () => overrides.available ?? true,
    supportsOnDeviceRecognition: () => overrides.onDevice ?? true,
    getSupportedLocales: async () => ({ locales: overrides.locales ?? ["en-AU", "en-US"], installedLocales: overrides.installed ?? ["en-AU"] }),
  });
  const opts = { locale: "en-AU", requireOnDevice: true, platform: "android" };

  it("accepts a device with en-AU installed", async () => {
    expect((await checkSpeechSupport(module(), opts)).ok).toBe(true);
  });
  it("refuses network fallback when on-device is unsupported", async () => {
    const result = await checkSpeechSupport(module({ onDevice: false }), opts);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Type/);
    expect((await checkSpeechSupport(module({ onDevice: false }), { ...opts, requireOnDevice: false })).ok).toBe(true);
  });
  it("offers a model download when the locale is not installed (Android)", async () => {
    const result = await checkSpeechSupport(module({ installed: ["en-US"] }), opts);
    expect(result).toMatchObject({ ok: false, canDownloadModel: true });
  });
  it("rejects unsupported locales and missing modules", async () => {
    expect((await checkSpeechSupport(module({ locales: ["de-DE"], installed: [] }), opts)).ok).toBe(false);
    expect((await checkSpeechSupport(null, opts)).ok).toBe(false);
    expect((await checkSpeechSupport(module({ available: false }), opts)).ok).toBe(false);
  });
  it("lets start() decide when locales cannot be enumerated", async () => {
    expect((await checkSpeechSupport(module({ locales: [], installed: [] }), opts)).ok).toBe(true);
  });
  it("maps error codes to actionable messages", () => {
    expect(describeSpeechError("not-allowed")).toMatch(/Settings/);
    expect(describeSpeechError("weird", "raw")).toBe("raw");
  });
});

describe("refresh observer", () => {
  it("wraps the React Refresh runtime and reports applied refreshes and compile errors", () => {
    const performReactRefresh = vi.fn();
    const performFullRefresh = vi.fn();
    const previousHandler = vi.fn();
    let handler: (error: unknown, fatal?: boolean) => void = () => {};
    const g = globalThis as Record<string, unknown>;
    g.__ReactRefresh = { performReactRefresh, performFullRefresh };
    g.ErrorUtils = { getGlobalHandler: () => previousHandler, setGlobalHandler: (h: typeof handler) => (handler = h) };
    const events: string[] = [];
    const { supported, unsubscribe } = observeRefresh((event) => events.push(event.kind));
    expect(supported).toBe(true);
    (g.__ReactRefresh as { performReactRefresh: () => void }).performReactRefresh();
    handler(new Error("SyntaxError /app/x.tsx: Unexpected token (3:4)"));
    handler(new Error("TypeError: undefined is not a function"));
    expect(performReactRefresh).toHaveBeenCalled();
    expect(previousHandler).toHaveBeenCalledTimes(2);
    expect(events).toEqual(["applied", "error"]);
    unsubscribe();
    expect(isCompileErrorMessage("Unable to resolve module ./Missing")).toBe(true);
  });
});
