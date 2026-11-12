/**
 * Version-specific access to React internals.
 *
 * Everything that touches private React / React Native structures lives in this file so it can be
 * adapted per React Native version without touching the rest of the inspector. The fields used are
 * the long-standing Fiber fields (`tag`, `type`, `return`, `child`, `sibling`, `memoizedProps`,
 * `stateNode`, `_debugOwner`) that React DevTools also depends on. They are not public API.
 */

export interface FiberLike {
  tag: number;
  type: unknown;
  elementType?: unknown;
  key?: string | null;
  return: FiberLike | null;
  child: FiberLike | null;
  sibling: FiberLike | null;
  memoizedProps: Record<string, unknown> | string | null;
  stateNode: unknown;
  /** Dev-only: the component whose render created this element (React 16+). */
  _debugOwner?: FiberLike | { name?: string } | null;
  /** Dev-only, React <= 18. Removed in React 19. */
  _debugSource?: { fileName: string; lineNumber: number; columnNumber?: number } | null;
}

/** React work tags (stable since React 16; HostHoistable/HostSingleton are DOM-only). */
export const FiberTag = {
  FunctionComponent: 0,
  ClassComponent: 1,
  HostRoot: 3,
  HostPortal: 4,
  HostComponent: 5,
  HostText: 6,
  Fragment: 7,
  Mode: 8,
  ContextConsumer: 9,
  ContextProvider: 10,
  ForwardRef: 11,
  Profiler: 12,
  SuspenseComponent: 13,
  MemoComponent: 14,
  SimpleMemoComponent: 15,
  HostHoistable: 26,
  HostSingleton: 27,
} as const;

const COMPOSITE_TAGS = new Set<number>([
  FiberTag.FunctionComponent,
  FiberTag.ClassComponent,
  FiberTag.ForwardRef,
  FiberTag.MemoComponent,
  FiberTag.SimpleMemoComponent,
]);

export function isHostFiber(fiber: FiberLike): boolean {
  return (
    fiber.tag === FiberTag.HostComponent ||
    fiber.tag === FiberTag.HostHoistable ||
    fiber.tag === FiberTag.HostSingleton
  );
}

export function isCompositeFiber(fiber: FiberLike): boolean {
  return COMPOSITE_TAGS.has(fiber.tag);
}

export function getDisplayName(type: unknown): string | null {
  if (type == null) return null;
  if (typeof type === "string") return type;
  if (typeof type === "function") {
    const fn = type as { displayName?: string; name?: string };
    return fn.displayName || fn.name || null;
  }
  if (typeof type === "object") {
    const obj = type as { displayName?: string; render?: unknown; type?: unknown };
    if (obj.displayName) return obj.displayName;
    if (obj.render) return getDisplayName(obj.render); // forwardRef
    if (obj.type) return getDisplayName(obj.type); // memo
  }
  return null;
}

export function getFiberName(fiber: FiberLike): string | null {
  return getDisplayName(fiber.type) ?? getDisplayName(fiber.elementType);
}

export function getProps(fiber: FiberLike): Record<string, unknown> {
  const props = fiber.memoizedProps;
  return props && typeof props === "object" ? props : {};
}

function readHandle(instance: unknown): FiberLike | null {
  if (!instance || typeof instance !== "object") return null;
  const record = instance as Record<string, unknown>;
  // React Native Fabric public instances (ReactNativeElement / ReactFabricHostComponent).
  const handle = record.__internalInstanceHandle ?? record._internalInstanceHandle;
  if (handle && typeof handle === "object" && "tag" in (handle as object)) return handle as FiberLike;
  // Legacy renderer (dev only).
  const legacy = record._internalFiberInstanceHandleDEV;
  if (legacy && typeof legacy === "object") return legacy as FiberLike;
  // react-dom (react-native-web): __reactFiber$<random>.
  for (const key of Object.keys(record)) {
    if (key.startsWith("__reactFiber$")) return record[key] as FiberLike;
  }
  return null;
}

/** Fiber of a host instance obtained from a `ref`. */
export function getFiberFromHostInstance(instance: unknown): FiberLike | null {
  return readHandle(instance);
}

export function getHostRoot(fiber: FiberLike): FiberLike | null {
  let current: FiberLike | null = fiber;
  while (current && current.return) current = current.return;
  return current && current.tag === FiberTag.HostRoot ? current : current;
}

/** Fabric shadow node for a host fiber, used by nativeFabricUIManager APIs. */
export function getShadowNode(fiber: FiberLike): unknown {
  const stateNode = fiber.stateNode as { node?: unknown } | null;
  return stateNode && typeof stateNode === "object" ? (stateNode.node ?? null) : null;
}

/** Returns the fiber stored in a Fabric instance handle returned by findNodeAtPoint. */
export function getCanonicalFiber(handle: unknown): FiberLike | null {
  if (!handle || typeof handle !== "object") return null;
  const fiber = handle as FiberLike;
  const stateNode = fiber.stateNode as { canonical?: { internalInstanceHandle?: FiberLike } } | null;
  return stateNode?.canonical?.internalInstanceHandle ?? fiber;
}

export function isAncestor(ancestor: FiberLike, fiber: FiberLike): boolean {
  let current: FiberLike | null = fiber;
  while (current) {
    if (current === ancestor || current === (ancestor as { alternate?: FiberLike }).alternate) return true;
    current = current.return;
  }
  return false;
}

export function nearestHostAncestor(fiber: FiberLike): FiberLike | null {
  let current = fiber.return;
  while (current) {
    if (isHostFiber(current)) return current;
    current = current.return;
  }
  return null;
}

/** Direct host descendants of a fiber (does not descend into nested host components). */
export function hostChildren(fiber: FiberLike): FiberLike[] {
  const result: FiberLike[] = [];
  const visit = (node: FiberLike | null) => {
    while (node) {
      if (isHostFiber(node)) result.push(node);
      else if (node.tag !== FiberTag.HostPortal) visit(node.child);
      node = node.sibling;
    }
  };
  visit(fiber.child);
  return result;
}

/** Depth-first host fibers under `fiber`, in paint order (later = drawn on top). */
export function collectHostFibers(fiber: FiberLike, skip?: (fiber: FiberLike) => boolean): FiberLike[] {
  const result: FiberLike[] = [];
  const visit = (node: FiberLike | null) => {
    while (node) {
      if (!skip || !skip(node)) {
        if (isHostFiber(node)) result.push(node);
        visit(node.child);
      }
      node = node.sibling;
    }
  };
  visit(fiber.child);
  return result;
}

/** Concatenated text rendered inside a host fiber (HostText descendants). */
export function collectText(fiber: FiberLike, max = 500): string {
  const parts: string[] = [];
  let length = 0;
  const visit = (node: FiberLike | null) => {
    while (node && length < max) {
      if (node.tag === FiberTag.HostText && typeof node.memoizedProps === "string") {
        parts.push(node.memoizedProps);
        length += node.memoizedProps.length;
      } else if (node.tag === FiberTag.HostComponent) {
        const children = getProps(node).children;
        if (typeof children === "string" || typeof children === "number") {
          // Fabric collapses single string children of RCTText into RCTRawText; DOM inlines them.
          if (!node.child) {
            parts.push(String(children));
            length += String(children).length;
          }
        }
      }
      if (node.child) visit(node.child);
      node = node.sibling;
    }
  };
  if (fiber.tag === FiberTag.HostText && typeof fiber.memoizedProps === "string") return fiber.memoizedProps;
  const ownChildren = getProps(fiber).children;
  if ((typeof ownChildren === "string" || typeof ownChildren === "number") && !fiber.child) {
    return String(ownChildren).slice(0, max);
  }
  visit(fiber.child);
  return parts.join("").replace(/\s+/g, " ").trim().slice(0, max);
}

export function getOwner(fiber: FiberLike): FiberLike | null {
  const owner = fiber._debugOwner;
  if (owner && typeof owner === "object" && "tag" in owner) return owner as FiberLike;
  return null;
}
