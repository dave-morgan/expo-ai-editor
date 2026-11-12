import { useCallback, useEffect, useRef, useState } from "react";
import { optional, type SpeechModule } from "./optional";

/**
 * On-device speech recognition through expo-speech-recognition.
 *
 * Audio never leaves the device through this package: recognition runs in the OS speech service
 * and only the transcript is returned. With `requireOnDevice` (default) the recognizer is started
 * with `requiresOnDeviceRecognition: true`; if the device cannot do that for the requested locale
 * we report it and the UI offers typed input instead. We never silently fall back to network
 * recognition.
 */

export type SpeechStatus = "unavailable" | "idle" | "starting" | "listening" | "stopping";

export interface SpeechOptions {
  locale: string;
  requireOnDevice: boolean;
  /** Called with the final transcript of one utterance. */
  onFinal?: (transcript: string) => void;
}

export interface SpeechSupport {
  ok: boolean;
  reason?: string;
  /** Android 13+: the offline model for the locale can be downloaded. */
  canDownloadModel?: boolean;
}

const normalizeLocale = (locale: string) => locale.toLowerCase().replace(/_/g, "-");

type ModuleApi = SpeechModule["ExpoSpeechRecognitionModule"];

/** Capability check, separated from React for unit testing. */
export async function checkSpeechSupport(
  module: Pick<ModuleApi, "isRecognitionAvailable" | "supportsOnDeviceRecognition" | "getSupportedLocales"> | null,
  options: { locale: string; requireOnDevice: boolean; platform: string },
): Promise<SpeechSupport> {
  if (!module) {
    return { ok: false, reason: "expo-speech-recognition is not installed in this development build." };
  }
  if (!module.isRecognitionAvailable()) {
    return { ok: false, reason: "Speech recognition is not available on this device." };
  }
  if (options.requireOnDevice && !module.supportsOnDeviceRecognition()) {
    return {
      ok: false,
      reason: "On-device speech recognition is not supported here. Type your instruction instead (audio is never uploaded).",
    };
  }
  try {
    const { locales, installedLocales } = await module.getSupportedLocales({});
    const wanted = normalizeLocale(options.locale);
    const all = locales.map(normalizeLocale);
    const installed = installedLocales.map(normalizeLocale);
    // Empty lists mean the platform cannot enumerate (Android <= 12); let start() decide.
    if (all.length > 0 && !all.includes(wanted) && !installed.includes(wanted)) {
      return { ok: false, reason: `The speech recognizer does not support ${options.locale}.` };
    }
    if (options.requireOnDevice && options.platform === "android" && installed.length > 0 && !installed.includes(wanted)) {
      return {
        ok: false,
        reason: `The on-device model for ${options.locale} is not installed.`,
        canDownloadModel: true,
      };
    }
  } catch {
    // getSupportedLocales can throw for unusual recognition services; start() reports errors.
  }
  return { ok: true };
}

const ERROR_MESSAGES: Record<string, string> = {
  "not-allowed": "Microphone or speech permission was denied. Enable it in Settings, or type instead.",
  "language-not-supported": "This language is not supported for on-device recognition. Type instead.",
  "service-not-allowed": "On-device recognition is unavailable. Type your instruction instead.",
  network: "The recognizer needed the network, which is disabled for on-device mode. Type instead.",
  "no-speech": "No speech detected. Try again.",
  "speech-timeout": "No speech detected. Try again.",
  "audio-capture": "The microphone could not be used.",
  busy: "The recognizer is busy. Try again in a moment.",
  interrupted: "Recording was interrupted.",
};

export function describeSpeechError(code: string, message?: string): string {
  return ERROR_MESSAGES[code] ?? message ?? `Speech recognition error (${code}).`;
}

const Speech = optional.speech();
const noopEvent = (_event: string, _listener: (...args: never[]) => void) => {};
const useSpeechEvent = (Speech?.useSpeechRecognitionEvent ?? noopEvent) as (
  event: string,
  listener: (payload: never) => void,
) => void;

export function useSpeechInput(options: SpeechOptions, platform: string) {
  const [status, setStatus] = useState<SpeechStatus>(Speech ? "idle" : "unavailable");
  const [partial, setPartial] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [support, setSupport] = useState<SpeechSupport | null>(Speech ? null : { ok: false, reason: "expo-speech-recognition is not installed." });
  const onFinalRef = useRef(options.onFinal);
  onFinalRef.current = options.onFinal;
  const cancelled = useRef(false);

  useEffect(() => {
    let alive = true;
    void checkSpeechSupport(Speech?.ExpoSpeechRecognitionModule ?? null, {
      locale: options.locale,
      requireOnDevice: options.requireOnDevice,
      platform,
    }).then((result) => {
      if (alive) setSupport(result);
    });
    return () => {
      alive = false;
    };
  }, [options.locale, options.requireOnDevice, platform]);

  useSpeechEvent("start", () => setStatus("listening"));
  useSpeechEvent("end", () => {
    setStatus(Speech ? "idle" : "unavailable");
    setPartial("");
  });
  useSpeechEvent("result", (event: { isFinal: boolean; results: Array<{ transcript: string }> }) => {
    if (cancelled.current) return;
    const transcript = event.results[0]?.transcript ?? "";
    if (event.isFinal) {
      setPartial("");
      if (transcript.trim()) onFinalRef.current?.(transcript.trim());
    } else {
      setPartial(transcript);
    }
  });
  useSpeechEvent("error", (event: { error: string; message: string }) => {
    if (event.error === "aborted") return;
    setError(describeSpeechError(event.error, event.message));
    setStatus("idle");
  });

  const start = useCallback(async () => {
    if (!Speech) return;
    setError(null);
    cancelled.current = false;
    if (support && !support.ok) {
      setError(support.reason ?? "Speech recognition unavailable.");
      return;
    }
    const module = Speech.ExpoSpeechRecognitionModule;
    const permission = await module.requestPermissionsAsync();
    if (!permission.granted) {
      setError(describeSpeechError("not-allowed"));
      return;
    }
    setStatus("starting");
    try {
      module.start({
        lang: options.locale,
        interimResults: true,
        continuous: false,
        maxAlternatives: 1,
        addsPunctuation: true,
        requiresOnDeviceRecognition: options.requireOnDevice,
      });
    } catch (startError) {
      setStatus("idle");
      setError((startError as Error).message);
    }
  }, [options.locale, options.requireOnDevice, support]);

  const stop = useCallback(() => {
    if (!Speech) return;
    setStatus("stopping");
    Speech.ExpoSpeechRecognitionModule.stop();
  }, []);

  const cancel = useCallback(() => {
    if (!Speech) return;
    cancelled.current = true;
    setPartial("");
    Speech.ExpoSpeechRecognitionModule.abort();
  }, []);

  const downloadModel = useCallback(async () => {
    if (!Speech) return;
    try {
      const result = await Speech.ExpoSpeechRecognitionModule.androidTriggerOfflineModelDownload({ locale: options.locale });
      setError(result.message || `Model download: ${result.status}`);
    } catch (downloadError) {
      setError((downloadError as Error).message);
    }
  }, [options.locale]);

  return { status, partial, error, support, start, stop, cancel, downloadModel, clearError: () => setError(null) };
}
