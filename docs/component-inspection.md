# Component selection and source mapping

This document explains how a tap at a screen coordinate becomes `Selection` metadata, and which
parts depend on private React / React Native internals.

## What we researched (React 19.3, React Native 0.88, Expo SDK 58)

| Option | Finding | Used? |
| --- | --- | --- |
| React `_debugSource` / JSX `__source` | Removed in React 19: the JSX dev transform no longer passes `__source`, and fibers have no `_debugSource`. Owner stacks (`_debugStack`) are Error objects whose frames need source maps. | Fallback only (React ≤ 18) |
| React Native Inspector (`getInspectorDataForViewAtPoint`) | Exists in the Fabric renderer's dev build, behind `ReactNativePrivateInterface`. Returns hierarchy and frame but not reliable source locations in React 19. Private. | No (we call the underlying primitive directly) |
| `nativeFabricUIManager.findNodeAtPoint(node, x, y, cb)` | Native C++ hit test over the shadow tree (`LayoutableShadowNode::findNodeAtPoint`). Honours transforms, overflow, `pointerEvents`, z-order. The callback receives the fiber's instance handle. | **Yes**, primary on iOS/Android |
| React Native DOM APIs (`getBoundingClientRect`) | Available on Fabric public instances in 0.88. | Measurements use `nativeFabricUIManager.measureInWindow` |
| React DevTools hook / source maps | Requires DevTools and symbolication round trips to Metro. Too slow for a tap and depends on DevTools protocol details. | No |
| **Development Babel transform** | Fully under our control, survives React upgrades, gives exact file:line:column. | **Yes**, primary source of locations |

## Pipeline

1. **Touch capture.** In selection mode the overlay renders a full-screen responder. Tap = select;
   hold 450 ms = select and start press-to-talk dictation.
2. **Hit test** (`src/inspection/hit-test.ts`). The overlay's own fiber is found from its host
   instance (`__internalInstanceHandle`). The overlay's host siblings (the app) are searched with:
   - `fabric-native`: `findNodeAtPoint` on each sibling subtree, top-most first, with the point
     converted into the parent's coordinate space;
   - `dom` (web): `document.elementsFromPoint`, skipping the overlay;
   - `geometry` (fallback): measure every host view and take the last one in paint order that
     contains the point. Reported as reduced confidence because it ignores `zIndex` and transforms.
3. **Fiber walk** (`src/inspection/metadata.ts`). From the host fiber up to the root:
   - **Touched host element**: the host fiber (`RCTText`), reported as the primitive the developer
     wrote (`Text`).
   - **Editable source**: the innermost fiber carrying `__aiSource`. Because the transform tags the
     JSX *call site*, this is the exact `<Text …>` expression in your code.
   - **Responsible component**: the `_debugOwner` of that fiber (the component whose render created
     it), for example `ProfileHeader`. Its own `__aiSource` is where *it* is used (`componentSource`).
   - **Hierarchy**: composite frames innermost first, each with its call site. Components are
     classified as app code when some JSX they rendered was tagged; otherwise `[lib]`.
   - **Context**: visible text (HostText descendants), testID, accessibility label/role, nativeID,
     flattened primitive style values, bounds, current expo-router pathname.
4. **Confidence**:
   - `high`: tagged JSX at most one component level above the touched host view;
   - `medium`: tagged JSX further up (inside library components), or legacy `_debugSource`;
   - `low`/`none`: no tag found. A note explains how to enable the transform. **No path or line
     is ever invented.**
   - Reusable components: when the selected text arrives as `children` of a reusable component
     (e.g. `<AppText>Welcome back</AppText>`), a note gives both locations: the usage site (to change
     only this instance) and the component file (to change every instance).

## The Babel transform

`@dave-morgan/expo-ai-inspector/babel` (`@dave-morgan/expo-ai-inspector-transform`) appends one attribute to every JSX
element in app code:

```jsx
<AppText variant="display">Welcome back</AppText>
// becomes
<AppText variant="display" __aiSource="src/components/ProfileHeader.tsx:17:6">Welcome back</AppText>
```

- Paths are relative to the Babel root (the Expo project root) with POSIX separators.
- Skipped: `node_modules`, fragments, lowercase intrinsics (DOM tags on web), already tagged elements.
- The attribute is added *after* spread props so a forwarded `{...props}` cannot overwrite it.
- Disabled automatically when Metro's Babel caller reports `isDev: false` (release builds,
  `expo export`), or with `["@dave-morgan/expo-ai-inspector/babel", { enabled: false }]`.
- Host components ignore the unknown prop (Fabric only forwards props in the view config). Your own
  components receive an extra string prop; components that spread unknown props onto DOM nodes on
  web may show an attribute in the DOM in development.
- After adding the plugin, clear Metro's cache once: `npx expo start -c`.

## Private APIs we rely on (all isolated in `src/inspection/fiber.ts` and `hit-test.ts`)

| Internal | Used for | If it changes |
| --- | --- | --- |
| Fiber fields `tag`, `type`, `return`, `child`, `sibling`, `memoizedProps`, `stateNode` | Walking the tree | Stable since React 16; DevTools depends on them |
| `_debugOwner` (dev builds) | Owner component | Falls back to nearest composite ancestor |
| `__internalInstanceHandle` on Fabric public instances | Overlay's fiber | Selection reports "Nothing selectable" |
| `stateNode.node` / `stateNode.canonical` (Fabric instance) | Shadow node / canonical fiber | Falls back to geometry strategy |
| `globalThis.nativeFabricUIManager.findNodeAtPoint` / `measureInWindow` | Native hit test, bounds | Falls back to geometry strategy |
| `global.__ReactRefresh.performReactRefresh` | Observing Fast Refresh | Refresh step stays "not observable" |

## Known gaps

- Elements inside React Native `Modal`, native-stack modal presentations or other native windows are
  not reachable: they live in a separate native root above the overlay.
- `zIndex`-reordered siblings are only handled by the native and DOM strategies.
- Text inside a single `<Text>` with nested `<Text>` spans selects the outer paragraph (Fabric hit
  tests text as one node).
- Generated elements (`.map`) resolve to the JSX inside the callback, which is the right place to
  edit but applies to every item.
