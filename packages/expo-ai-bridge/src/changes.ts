import { statSync, watch } from "node:fs";
import { isAbsolute, join, posix } from "node:path";

function normalize(file: string) {
  return file.replaceAll("\\", "/").replace(/^\.\//, "");
}
export function isIgnoredChange(file: string) {
  const path = normalize(file);
  if (!path || isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.split("/").includes(".."))
    return true;
  const parts = path.split("/");
  return (
    parts.some((part) =>
      ["node_modules", ".git", ".expo", ".expo-ai", "dist", "build", ".cxx", ".gradle", ".claude", ".codex", ".idea", ".vscode", ".turbo", ".cache"].includes(part),
    ) ||
    path === "android/.gradle" ||
    path.startsWith("android/.gradle/") ||
    /\.log$/i.test(path)
  );
}

export function isNativeChange(file: string) {
  const path = normalize(file);
  return (
    /^(?:app\.json|app\.config\.(?:js|ts|mjs|cjs)|package\.json|eas\.json|react-native\.config\.js)$/.test(
      path,
    ) ||
    /^(?:ios|android|plugins)\//.test(path) ||
    /\.podspec$/.test(path) ||
    /^Podfile[^/]*$/.test(posix.basename(path))
  );
}

/**
 * fs.watch on Windows (and some Linux setups) also reports directories and files whose access
 * time changed when an agent merely reads them. Keep only real modifications: regular files whose
 * mtime moved recently, and paths that no longer exist (deletions).
 */
export function isRealModification(root: string, file: string, now = Date.now(), windowMs = 10_000): boolean {
  try {
    const stats = statSync(join(root, file));
    if (stats.isDirectory()) return false;
    return stats.mtimeMs >= now - windowMs;
  } catch {
    // Deleted or renamed away. Editors and agents write through short-lived temp files
    // (no extension, *.tmp, *~, .#lock); those are noise, real deletions are kept.
    const name = posix.basename(file.replaceAll("\\", "/"));
    return !(!name.includes(".") || /\.(tmp|temp|swp)$|~$|^\.#/i.test(name));
  }
}

export interface ChangeWatcher {
  close(): void;
}
export type WatcherFactory = (
  root: string,
  onFile: (filename: string | null) => void,
) => ChangeWatcher;
export const defaultWatcherFactory: WatcherFactory = (root, onFile) =>
  watch(root, { recursive: true }, (_event, filename) =>
    onFile(filename === null ? null : filename.toString()),
  );

/** Consumers attribute a batch to the most recent submitted/agent request, or
 * a request completed in the last 120 seconds; this is a timing heuristic. */
export function createChangeWatcher({
  root,
  onChange,
  watcherFactory = defaultWatcherFactory,
  debounceMs = 300,
  filter = (file: string) => isRealModification(root, file),
}: {
  root: string;
  onChange: (files: string[]) => void;
  watcherFactory?: WatcherFactory;
  debounceMs?: number;
  /** Final check applied when a batch is flushed; injectable for tests. */
  filter?: (file: string) => boolean;
}): ChangeWatcher {
  const files = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const watcher = watcherFactory(root, (filename) => {
    if (closed || filename === null || isIgnoredChange(filename)) return;
    if (files.size < 50) files.add(normalize(filename));
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const batch = [...files].filter((file) => filter(file));
      files.clear();
      timer = undefined;
      if (batch.length > 0) onChange(batch);
    }, debounceMs);
    timer.unref?.();
  });
  return {
    close() {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      files.clear();
      watcher.close();
    },
  };
}
