/**
 * Observes Fast Refresh on the device by wrapping the `__ReactRefresh` object React Native
 * installs in development (Libraries/Core/setUpReactRefresh.js). Metro's require polyfill calls
 * `performReactRefresh()` after applying an update and `performFullRefresh(reason)` when it must
 * reload. This is a private, dev-only contract; if it is missing nothing is reported.
 *
 * Compile errors are observed through React Native's global error handler: Metro's HMR client
 * throws the compile error so that it reaches LogBox via ErrorUtils.
 */
export type RefreshEvent = { kind: "applied" | "full-reload" | "error"; message?: string };

type RefreshRuntime = {
  performReactRefresh?: (...args: unknown[]) => unknown;
  performFullRefresh?: (reason: string) => unknown;
  __expoAiWrapped?: boolean;
};

type ErrorUtilsLike = {
  getGlobalHandler(): (error: unknown, isFatal?: boolean) => void;
  setGlobalHandler(handler: (error: unknown, isFatal?: boolean) => void): void;
};

const listeners = new Set<(event: RefreshEvent) => void>();
let installed = false;

function emit(event: RefreshEvent) {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // ignore listener failures
    }
  }
}

const COMPILE_ERROR = /^(SyntaxError|TransformError|UnableToResolveError|NotFoundError)\b|Unable to resolve module/;

export function isCompileErrorMessage(message: string): boolean {
  return COMPILE_ERROR.test(message);
}

function install(): boolean {
  if (installed) return true;
  const g = globalThis as Record<string, unknown>;
  const prefix = typeof g.__METRO_GLOBAL_PREFIX__ === "string" ? g.__METRO_GLOBAL_PREFIX__ : "";
  const runtime = g[prefix + "__ReactRefresh"] as RefreshRuntime | undefined;
  if (!runtime) return false;
  if (!runtime.__expoAiWrapped) {
    const performReactRefresh = runtime.performReactRefresh;
    if (typeof performReactRefresh === "function") {
      runtime.performReactRefresh = function wrapped(this: unknown, ...args: unknown[]) {
        const result = performReactRefresh.apply(this, args);
        emit({ kind: "applied" });
        return result;
      };
    }
    const performFullRefresh = runtime.performFullRefresh;
    if (typeof performFullRefresh === "function") {
      runtime.performFullRefresh = function wrapped(this: unknown, reason: string) {
        emit({ kind: "full-reload", message: String(reason ?? "") });
        return performFullRefresh.call(this, reason);
      };
    }
    runtime.__expoAiWrapped = true;

    const errorUtils = g.ErrorUtils as ErrorUtilsLike | undefined;
    if (errorUtils?.getGlobalHandler && errorUtils.setGlobalHandler) {
      const previous = errorUtils.getGlobalHandler();
      errorUtils.setGlobalHandler((error, isFatal) => {
        const message = error instanceof Error ? error.message : String(error);
        if (isCompileErrorMessage(message)) emit({ kind: "error", message: message.slice(0, 2000) });
        previous(error, isFatal);
      });
    }
  }
  installed = true;
  return true;
}

export function observeRefresh(listener: (event: RefreshEvent) => void): { supported: boolean; unsubscribe: () => void } {
  const supported = install();
  listeners.add(listener);
  return { supported, unsubscribe: () => void listeners.delete(listener) };
}
