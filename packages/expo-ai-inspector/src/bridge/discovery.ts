/**
 * Derives the bridge URL from the Metro dev-server host the app was loaded from, so a physical
 * device reaches the bridge on the same machine without configuration.
 */
export const DEFAULT_BRIDGE_PORT = 8790;

export interface DiscoveryInput {
  /** `Constants.expoConfig.hostUri`, e.g. `192.168.1.20:8081`. */
  hostUri?: string | null;
  /** Bundle URL, e.g. `http://192.168.1.20:8081/index.bundle?platform=ios`. */
  scriptURL?: string | null;
  /** `window.location.hostname` on web. */
  webHostname?: string | null;
  port?: number;
}

export function hostFromHostUri(hostUri: string): string | null {
  const trimmed = hostUri.replace(/^[a-z]+:\/\//i, "").split("/")[0] ?? "";
  if (!trimmed) return null;
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end > 0 ? trimmed.slice(0, end + 1) : null; // IPv6
  }
  return trimmed.split(":")[0] || null;
}

export function discoverBridgeUrl(input: DiscoveryInput): string | null {
  const port = input.port ?? DEFAULT_BRIDGE_PORT;
  const host =
    (input.hostUri ? hostFromHostUri(input.hostUri) : null) ??
    (input.scriptURL && /^https?:\/\//.test(input.scriptURL) ? hostFromHostUri(input.scriptURL) : null) ??
    input.webHostname ??
    null;
  return host ? `http://${host}:${port}` : null;
}
