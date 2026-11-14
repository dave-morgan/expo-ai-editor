/**
 * Optional peer dependencies are loaded lazily so the inspector still works, with fewer features,
 * when they are not installed. Metro resolves these `require` calls at build time; a missing
 * module throws at runtime and is reported as unavailable.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

function tryRequire<T>(load: () => T): T | null {
  try {
    return load();
  } catch {
    return null;
  }
}

export type SpeechModule = typeof import("expo-speech-recognition");

export interface SecureStoreModule {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

export const optional = {
  constants: (): any => tryRequire(() => require("expo-constants").default),
  speech: (): SpeechModule | null => tryRequire(() => require("expo-speech-recognition") as SpeechModule),
  viewShot: (): { captureScreen: (opts: object) => Promise<string> } | null =>
    tryRequire(() => require("react-native-view-shot")),
  secureStore: (): SecureStoreModule | null => tryRequire(() => require("expo-secure-store") as SecureStoreModule),
  router: (): { usePathname?: () => string } | null => tryRequire(() => require("expo-router")),
  /** Static insets only (no provider needed): used to keep the panel above the gesture bar. */
  safeArea: (): { initialWindowMetrics?: { insets: { bottom: number } } | null } | null =>
    tryRequire(() => require("react-native-safe-area-context")),
};
