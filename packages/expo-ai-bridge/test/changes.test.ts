import { describe, expect, it, vi } from "vitest";
import { createChangeWatcher, isIgnoredChange, isNativeChange } from "../src/changes.js";

describe("source changes", () => {
  it.each([
    "app.json",
    "app.config.ts",
    "app.config.mjs",
    "package.json",
    "eas.json",
    "ios/App/View.m",
    "android/app/Main.kt",
    "plugins/withApp.js",
    "native/My.podspec",
    "ios/Podfile.lock",
    "react-native.config.js",
  ])("detects native config %s", (file) => {
    expect(isNativeChange(file)).toBe(true);
  });
  it.each(["src/Header.tsx", "src/app.json", "README.md"])(
    "keeps ordinary source changes %s",
    (file) => {
      expect(isNativeChange(file)).toBe(false);
    },
  );
  it.each([
    "node_modules/a.ts",
    ".git/index",
    ".expo/state",
    ".expo-ai/screenshots/a.jpg",
    "dist/a.js",
    "build/a.js",
    "ios/build/a",
    "android/build/a",
    "android/.gradle/a",
    "debug.log",
    "src/node_modules/a.js",
    "../outside.ts",
  ])("ignores %s", (file) => {
    expect(isIgnoredChange(file)).toBe(true);
  });
  it("debounces, normalizes paths, removes duplicates and caps batches at 50", () => {
    vi.useFakeTimers();
    let report: (filename: string | null) => void = () => {};
    const close = vi.fn();
    const onChange = vi.fn();
    const watcher = createChangeWatcher({
      root: "/app",
      onChange,
      watcherFactory: (_root, callback) => {
        report = callback;
        return { close };
      },
    });
    report("src\\Header.tsx");
    report("src/Header.tsx");
    report(".expo-ai/a.jpg");
    report(null);
    vi.advanceTimersByTime(299);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledWith(["src/Header.tsx"]);
    for (let i = 0; i < 80; i++) report(`src/File${i}.ts`);
    vi.advanceTimersByTime(300);
    expect(onChange.mock.calls[1]?.[0]).toHaveLength(50);
    report("src/Pending.ts");
    watcher.close();
    vi.advanceTimersByTime(300);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
