import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChangeWatcher, isIgnoredChange, isNativeChange, isRealModification } from "../src/changes.js";

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
  it("keeps only real file modifications (not directories or read-only access events)", () => {
    const root = mkdtempSync(join(tmpdir(), "expo-ai-changes-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "fresh.tsx"), "x");
    writeFileSync(join(root, "src", "old.tsx"), "x");
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(root, "src", "old.tsx"), past, past);
    expect(isRealModification(root, "src")).toBe(false);
    expect(isRealModification(root, "src/old.tsx")).toBe(false);
    expect(isRealModification(root, "src/fresh.tsx")).toBe(true);
    expect(isRealModification(root, "src/deleted.tsx")).toBe(true);
    expect(isRealModification(root, "src/components/sedun7G2x")).toBe(false);
    expect(isRealModification(root, "src/Header.tsx.tmp")).toBe(false);
    expect(isIgnoredChange(".claude/settings.json")).toBe(true);
    expect(isIgnoredChange("android/app/.cxx/x.o")).toBe(true);
  });
});
