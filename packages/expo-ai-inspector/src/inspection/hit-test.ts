import type { Bounds } from "@expo-ai/protocol";
import {
  collectHostFibers,
  getCanonicalFiber,
  getFiberFromHostInstance,
  getHostRoot,
  getShadowNode,
  hostChildren,
  isAncestor,
  nearestHostAncestor,
  type FiberLike,
} from "./fiber";

export type HitTestStrategy = "fabric-native" | "dom" | "geometry";

export interface HitResult {
  fiber: FiberLike;
  bounds: Bounds;
  strategy: HitTestStrategy;
  overlappingCandidates?: number;
}

interface FabricUIManager {
  findNodeAtPoint(node: unknown, x: number, y: number, callback: (handle: unknown) => void): void;
  measureInWindow(node: unknown, callback: (x: number, y: number, width: number, height: number) => void): void;
}

function getFabric(): FabricUIManager | null {
  const candidate = (globalThis as { nativeFabricUIManager?: Partial<FabricUIManager> }).nativeFabricUIManager;
  return candidate && typeof candidate.findNodeAtPoint === "function" && typeof candidate.measureInWindow === "function"
    ? (candidate as FabricUIManager)
    : null;
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** Window-relative bounds of a host fiber, or null when it cannot be measured. */
export function measureHost(fiber: FiberLike): Promise<Bounds | null> {
  const fabric = getFabric();
  const node = getShadowNode(fiber);
  if (fabric && node) {
    return withTimeout(
      new Promise<Bounds | null>((resolve) => {
        fabric.measureInWindow(node, (x, y, width, height) => resolve({ x, y, width, height }));
      }),
      500,
      null,
    );
  }
  const stateNode = fiber.stateNode as {
    getBoundingClientRect?: () => { left: number; top: number; width: number; height: number };
    measureInWindow?: (cb: (x: number, y: number, w: number, h: number) => void) => void;
  } | null;
  if (stateNode?.getBoundingClientRect) {
    const rect = stateNode.getBoundingClientRect();
    return Promise.resolve({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
  }
  if (stateNode?.measureInWindow) {
    const measure = stateNode.measureInWindow.bind(stateNode);
    return withTimeout(
      new Promise<Bounds | null>((resolve) => measure((x, y, width, height) => resolve({ x, y, width, height }))),
      500,
      null,
    );
  }
  return Promise.resolve(null);
}

/**
 * Host subtrees to search: siblings of the inspector overlay under their common host parent.
 * Excluding the overlay's own subtree means the transparent touch catcher never hits itself.
 */
function searchRoots(overlay: FiberLike): { container: FiberLike | null; roots: FiberLike[] } {
  const container = nearestHostAncestor(overlay);
  const parent = container ?? getHostRoot(overlay);
  if (!parent) return { container: null, roots: [] };
  const roots = hostChildren(parent).filter((child) => child !== overlay && !isAncestor(child, overlay));
  return { container, roots };
}

async function fabricHitTest(overlay: FiberLike, x: number, y: number): Promise<HitResult | null> {
  const fabric = getFabric();
  if (!fabric) return null;
  const { container, roots } = searchRoots(overlay);
  let localX = x;
  let localY = y;
  if (container) {
    const origin = await measureHost(container);
    if (!origin) return null;
    localX = x - origin.x;
    localY = y - origin.y;
  }
  // Later siblings are drawn on top: search in reverse paint order.
  for (const root of [...roots].reverse()) {
    const node = getShadowNode(root);
    if (!node) continue;
    const handle = await withTimeout(
      new Promise<unknown>((resolve) => fabric.findNodeAtPoint(node, localX, localY, resolve)),
      500,
      null,
    );
    const fiber = getCanonicalFiber(handle);
    if (!fiber || isAncestor(overlay, fiber)) continue;
    const bounds = await measureHost(fiber);
    if (bounds) return { fiber, bounds, strategy: "fabric-native" };
  }
  return null;
}

function domHitTest(overlay: FiberLike, x: number, y: number): HitResult | null {
  const doc = (globalThis as { document?: { elementsFromPoint?: (x: number, y: number) => unknown[] } }).document;
  if (!doc?.elementsFromPoint) return null;
  const overlayElement = overlay.stateNode as { contains?: (node: unknown) => boolean } | null;
  const elements = doc.elementsFromPoint(x, y);
  for (const element of elements) {
    if (overlayElement?.contains?.(element)) continue;
    const fiber = getFiberFromHostInstance(element);
    if (!fiber) continue;
    const rect = (element as { getBoundingClientRect: () => { left: number; top: number; width: number; height: number } }).getBoundingClientRect();
    return {
      fiber,
      bounds: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      strategy: "dom",
      overlappingCandidates: Math.max(0, elements.length - 1),
    };
  }
  return null;
}

export interface Candidate {
  index: number;
  depth: number;
  bounds: Bounds;
}

/**
 * Picks the top-most candidate containing the point. Candidates are in depth-first pre-order,
 * which is paint order when zIndex is not used: a descendant comes after its ancestors and a
 * later sibling's subtree after an earlier one, so the last containing candidate is on top.
 * Zero-area boxes are ignored. Exported for unit tests.
 */
export function pickCandidate(candidates: Candidate[], x: number, y: number): Candidate | null {
  let best: Candidate | null = null;
  for (const candidate of candidates) {
    const { bounds } = candidate;
    if (bounds.width <= 0 || bounds.height <= 0) continue;
    const inside = x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height;
    if (inside && (!best || candidate.index > best.index)) best = candidate;
  }
  return best;
}

function depthOf(fiber: FiberLike): number {
  let depth = 0;
  for (let node = fiber.return; node; node = node.return) depth += 1;
  return depth;
}

async function geometryHitTest(overlay: FiberLike, x: number, y: number): Promise<HitResult | null> {
  const { roots } = searchRoots(overlay);
  const fibers: FiberLike[] = [];
  for (const root of roots) {
    fibers.push(root, ...collectHostFibers(root));
    if (fibers.length > 3000) break;
  }
  const measured = await Promise.all(fibers.slice(0, 3000).map((fiber) => measureHost(fiber)));
  const candidates: Candidate[] = [];
  measured.forEach((bounds, index) => {
    if (bounds) candidates.push({ index, depth: depthOf(fibers[index]!), bounds });
  });
  const best = pickCandidate(candidates, x, y);
  if (!best) return null;
  const overlapping = candidates.filter(
    (c) => c !== best && x >= c.bounds.x && x <= c.bounds.x + c.bounds.width && y >= c.bounds.y && y <= c.bounds.y + c.bounds.height,
  ).length;
  return { fiber: fibers[best.index]!, bounds: best.bounds, strategy: "geometry", overlappingCandidates: overlapping };
}

/**
 * Finds the host element under a window coordinate, ignoring the inspector overlay.
 * `overlayInstance` is the host instance (ref) of the inspector's root view.
 */
export async function hitTest(overlayInstance: unknown, x: number, y: number): Promise<HitResult | null> {
  const overlay = getFiberFromHostInstance(overlayInstance);
  if (!overlay) return null;
  const dom = domHitTest(overlay, x, y);
  if (dom) return dom;
  try {
    const native = await fabricHitTest(overlay, x, y);
    if (native) return native;
  } catch {
    // fall through to geometry
  }
  return geometryHitTest(overlay, x, y);
}
