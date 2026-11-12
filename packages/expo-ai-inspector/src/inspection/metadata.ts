import type { Bounds, ComponentFrame, Confidence, Selection, SourceLocation, SourceOrigin } from "@expo-ai/protocol";
import { LIMITS } from "@expo-ai/protocol";
import {
  collectText,
  getFiberName,
  getOwner,
  getProps,
  isCompositeFiber,
  isHostFiber,
  type FiberLike,
} from "./fiber";

export const SOURCE_PROP = "__aiSource";

/** Parses `path/to/File.tsx:12:4` produced by @expo-ai/inspector-transform. */
export function parseSourceProp(value: unknown): SourceLocation | null {
  if (typeof value !== "string") return null;
  const match = /^(.+):(\d+):(\d+)$/.exec(value);
  if (!match) return null;
  const line = Number(match[2]);
  if (!Number.isInteger(line) || line < 1) return null;
  return { file: match[1]!, line, column: Number(match[3]) };
}

function sourceFromFiber(fiber: FiberLike): { source: SourceLocation; origin: SourceOrigin } | null {
  const tagged = parseSourceProp(getProps(fiber)[SOURCE_PROP]);
  if (tagged) return { source: tagged, origin: "babel-transform" };
  const legacy = fiber._debugSource;
  if (legacy && typeof legacy.fileName === "string" && legacy.lineNumber > 0) {
    return {
      source: { file: legacy.fileName.replace(/\\/g, "/"), line: legacy.lineNumber, column: legacy.columnNumber },
      origin: "react-debug-source",
    };
  }
  return null;
}

/** Host component names emitted by React Native, mapped to the component developers write. */
const HOST_NAME_MAP: Record<string, string> = {
  RCTView: "View",
  RCTText: "Text",
  RCTVirtualText: "Text",
  RCTParagraph: "Text",
  RCTScrollView: "ScrollView",
  RCTScrollContentView: "ScrollView content",
  AndroidHorizontalScrollView: "ScrollView",
  AndroidHorizontalScrollContentView: "ScrollView content",
  RCTImageView: "Image",
  AndroidTextInput: "TextInput",
  RCTSinglelineTextInputView: "TextInput",
  RCTMultilineTextInputView: "TextInput",
  RCTSwitch: "Switch",
  AndroidSwitch: "Switch",
  RCTSafeAreaView: "SafeAreaView",
  RCTActivityIndicatorView: "ActivityIndicator",
  AndroidProgressBar: "ActivityIndicator",
  RCTModalHostView: "Modal",
};

const PRIMITIVE_COMPONENTS = new Set([
  "View",
  "Text",
  "Image",
  "TextInput",
  "ScrollView",
  "FlatList",
  "SectionList",
  "Pressable",
  "TouchableOpacity",
  "TouchableHighlight",
  "Switch",
  "ActivityIndicator",
  "SafeAreaView",
]);

export function friendlyHostName(hostType: string): string {
  return HOST_NAME_MAP[hostType] ?? hostType;
}

function flattenStyle(style: unknown, flatten?: (style: unknown) => unknown): Record<string, string | number | boolean | null> | undefined {
  let flat: unknown = style;
  if (flatten) {
    try {
      flat = flatten(style);
    } catch {
      flat = undefined;
    }
  } else if (Array.isArray(style)) {
    flat = Object.assign({}, ...style.flat(Infinity).filter((s) => s && typeof s === "object"));
  }
  if (!flat || typeof flat !== "object") return undefined;
  const result: Record<string, string | number | boolean | null> = {};
  let count = 0;
  for (const [key, value] of Object.entries(flat as Record<string, unknown>)) {
    if (count >= LIMITS.maxStyleEntries) break;
    if (typeof value === "number" || typeof value === "boolean" || value === null) result[key] = value;
    else if (typeof value === "string") result[key] = value.slice(0, 200);
    else continue; // transforms, shadows offsets etc. are omitted rather than misrepresented
    count += 1;
  }
  return count > 0 ? result : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) if (typeof value === "string" && value.length > 0) return value;
  return undefined;
}

function childrenText(children: unknown): string | null {
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children) && children.every((c) => typeof c === "string" || typeof c === "number")) {
    return children.join("");
  }
  return null;
}

export interface BuildSelectionInput {
  host: FiberLike;
  bounds: Bounds;
  screen?: string;
  overlappingCandidates?: number;
  flattenStyle?: (style: unknown) => unknown;
  /** Strategy used to locate the element; recorded in confidence notes when it is a fallback. */
  hitTestStrategy?: string;
}

/**
 * Normalizes a selected host fiber into protocol `Selection` metadata.
 *
 * Distinguishes (1) the touched host element, (2) the component that rendered it (its owner)
 * and (3) the most relevant editable source location (innermost JSX call site in app code).
 * Never invents source locations: if no transform tag or debug source exists, `source` is omitted.
 */
export function buildSelection(input: BuildSelectionInput): Selection {
  const { host } = input;
  const hostType = typeof host.type === "string" ? host.type : (getFiberName(host) ?? "Unknown");
  const notes: string[] = [];

  // Walk from the host element to the root, collecting composite frames and the first source.
  const path: FiberLike[] = [];
  for (let node: FiberLike | null = host; node; node = node.return) path.push(node);

  let selected: { fiber: FiberLike; source: SourceLocation; origin: SourceOrigin; hops: number } | null = null;
  let compositeHops = 0;
  const userDefined = new Map<FiberLike, string>(); // owner fiber -> file where its JSX lives
  for (const fiber of path) {
    const found = sourceFromFiber(fiber);
    if (found) {
      if (!selected) selected = { fiber, ...found, hops: compositeHops };
      const owner = getOwner(fiber) ?? nearestCompositeAbove(fiber);
      if (owner && !userDefined.has(owner)) userDefined.set(owner, found.source.file);
    }
    if (fiber !== host && isCompositeFiber(fiber)) compositeHops += 1;
  }

  const frames: ComponentFrame[] = [];
  for (const fiber of path) {
    if (!isCompositeFiber(fiber)) continue;
    const name = getFiberName(fiber);
    if (!name) continue;
    const isLibrary = !isUserDefined(fiber, userDefined);
    // Keep the first few library frames for context (e.g. Text, Pressable) but drop deep
    // navigation/provider internals that only add noise.
    if (isLibrary && frames.filter((f) => f.isLibrary).length >= 3) continue;
    const callSite = sourceFromFiber(fiber)?.source;
    frames.push({ name: name.slice(0, 200), isLibrary, ...(callSite ? { source: callSite } : {}) });
    if (frames.length >= LIMITS.maxHierarchyDepth) break;
  }

  // Element type: prefer the primitive component the developer wrote (Text) over host names (RCTText).
  const nearestComposite = path.find((fiber) => fiber !== host && isCompositeFiber(fiber));
  const nearestName = nearestComposite ? getFiberName(nearestComposite) : null;
  const elementType =
    nearestName && PRIMITIVE_COMPONENTS.has(nearestName) ? nearestName : friendlyHostName(hostType);

  // Owning component: the user component whose render produced the selected JSX.
  let componentName: string | undefined;
  let componentSource: SourceLocation | undefined;
  if (selected) {
    const owner = getOwner(selected.fiber) ?? nearestCompositeAbove(selected.fiber);
    if (owner) {
      componentName = getFiberName(owner) ?? undefined;
      componentSource = sourceFromFiber(owner)?.source;
    }
  } else {
    const firstUser = path.find((fiber) => isCompositeFiber(fiber) && isUserDefined(fiber, userDefined));
    componentName = firstUser ? (getFiberName(firstUser) ?? undefined) : undefined;
  }

  const visibleText = collectText(host, LIMITS.maxVisibleTextChars) || undefined;

  // Confidence.
  let confidence: Confidence;
  if (!selected) {
    confidence = componentName ? "low" : "none";
    notes.push(
      "No JSX source location found. Is expo-ai-inspector/babel in babel.config.js, and was the Metro cache cleared (npx expo start -c)?",
    );
  } else if (selected.origin === "react-debug-source") {
    confidence = "medium";
    notes.push("Source from React _debugSource (absolute path, legacy React).");
  } else if (selected.hops <= 1) {
    confidence = "high";
  } else {
    confidence = "medium";
    notes.push(
      `Nearest tagged JSX is ${selected.hops} component levels above the touched element (inside library components).`,
    );
  }

  // Text passed through a reusable component: point at the usage site as well.
  if (selected && visibleText) {
    const owner = getOwner(selected.fiber) ?? nearestCompositeAbove(selected.fiber);
    const ownerText = owner ? childrenText(getProps(owner).children) : null;
    const ownerCallSite = owner ? sourceFromFiber(owner)?.source : undefined;
    if (owner && ownerText && ownerCallSite && visibleText.includes(ownerText.trim())) {
      notes.push(
        `The text is passed as children to reusable component ${getFiberName(owner)} at ${ownerCallSite.file}:${ownerCallSite.line}; edit that usage to change only this instance, or ${selected.source.file} to change every ${getFiberName(owner)}.`,
      );
    }
  }

  if (input.hitTestStrategy && input.hitTestStrategy !== "fabric-native" && input.hitTestStrategy !== "dom") {
    notes.push(`Element located with ${input.hitTestStrategy} hit testing; overlapping or transformed views may be misidentified.`);
  }
  if ((input.overlappingCandidates ?? 0) > 3) {
    notes.push(`${input.overlappingCandidates} other elements were under the touch point.`);
  }

  // Accessibility metadata: host first, then the nearest composite (e.g. Pressable receives testID).
  const hostProps = getProps(host);
  const compositeProps = nearestComposite ? getProps(nearestComposite) : {};
  const testID = firstString(hostProps.testID, compositeProps.testID, hostProps["data-testid"]);
  const accessibilityLabel = firstString(
    hostProps.accessibilityLabel,
    hostProps["aria-label"],
    compositeProps.accessibilityLabel,
    compositeProps["aria-label"],
  );
  const accessibilityRole = firstString(hostProps.accessibilityRole, hostProps.role, compositeProps.accessibilityRole, compositeProps.role);
  const nativeID = firstString(hostProps.nativeID, hostProps.id);
  const style = flattenStyle(hostProps.style, input.flattenStyle);

  const selection: Selection = {
    elementType,
    sourceOrigin: selected?.origin ?? "none",
    confidence,
    confidenceNotes: notes.slice(0, 10).map((note) => note.slice(0, 300)),
    hierarchy: frames,
    bounds: roundBounds(input.bounds),
  };
  if (input.screen) selection.screen = input.screen;
  if (componentName) selection.componentName = componentName.slice(0, 200);
  if (selected) selection.source = selected.source;
  if (componentSource) selection.componentSource = componentSource;
  if (visibleText) selection.visibleText = visibleText;
  if (testID) selection.testID = testID.slice(0, 200);
  if (accessibilityLabel) selection.accessibilityLabel = accessibilityLabel.slice(0, 300);
  if (accessibilityRole) selection.accessibilityRole = accessibilityRole.slice(0, 100);
  if (nativeID) selection.nativeID = nativeID.slice(0, 200);
  if (style) selection.style = style;
  if (input.overlappingCandidates !== undefined) selection.overlappingCandidates = input.overlappingCandidates;
  return selection;
}

function nearestCompositeAbove(fiber: FiberLike): FiberLike | null {
  for (let node = fiber.return; node; node = node.return) {
    if (isCompositeFiber(node)) return node;
    if (isHostFiber(node)) continue;
  }
  return null;
}

function isUserDefined(fiber: FiberLike, userDefined: Map<FiberLike, string>): boolean {
  if (userDefined.has(fiber)) return true;
  const alternate = (fiber as { alternate?: FiberLike | null }).alternate;
  return alternate ? userDefined.has(alternate) : false;
}

function roundBounds(bounds: Bounds): Bounds {
  const r = (value: number) => Math.round(value * 10) / 10;
  return { x: r(bounds.x), y: r(bounds.y), width: Math.max(0, r(bounds.width)), height: Math.max(0, r(bounds.height)) };
}
