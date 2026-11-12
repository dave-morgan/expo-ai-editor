export { AIInspector, INSPECTOR_VERSION, type AIInspectorProps } from "./AIInspector";
export { BridgeClient, MemoryTokenStore, type ConnectionState, type TokenStore, type BridgeClientOptions } from "./bridge/client";
export { discoverBridgeUrl, DEFAULT_BRIDGE_PORT } from "./bridge/discovery";
export { buildSelection, parseSourceProp, SOURCE_PROP } from "./inspection/metadata";
export { hitTest, pickCandidate, type HitResult } from "./inspection/hit-test";
export type { InspectorSettings } from "./state/inspector-state";
