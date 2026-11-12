import type { FiberLike } from "../src/inspection/fiber";
import { FiberTag } from "../src/inspection/fiber";

type Spec = {
  tag: number;
  type: unknown;
  props?: Record<string, unknown> | string;
  owner?: string;
  name?: string;
  children?: Spec[];
};

/** Builds a linked fiber tree. "owner" refers to another spec's "name". */
export function buildTree(root: Spec): { root: FiberLike; byName: Map<string, FiberLike> } {
  const byName = new Map<string, FiberLike>();
  const owners: Array<[FiberLike, string]> = [];
  const make = (spec: Spec, parent: FiberLike | null): FiberLike => {
    const fiber: FiberLike = {
      tag: spec.tag,
      type: spec.type,
      return: parent,
      child: null,
      sibling: null,
      memoizedProps: spec.props ?? {},
      stateNode: null,
    };
    if (spec.name) byName.set(spec.name, fiber);
    if (spec.owner) owners.push([fiber, spec.owner]);
    let previous: FiberLike | null = null;
    for (const childSpec of spec.children ?? []) {
      const child = make(childSpec, fiber);
      if (previous) previous.sibling = child;
      else fiber.child = child;
      previous = child;
    }
    return fiber;
  };
  const rootFiber = make(root, null);
  for (const [fiber, ownerName] of owners) fiber._debugOwner = byName.get(ownerName) ?? null;
  return { root: rootFiber, byName };
}

export const fn = (name: string) => Object.assign(function () {}, { displayName: name });
export { FiberTag };
