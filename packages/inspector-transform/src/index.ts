import * as path from "node:path";
import type { NodePath, PluginObj, PluginPass, types as BabelTypes } from "@babel/core";

/**
 * Prop name attached to every JSX element created in application code.
 * Value format: `<posix path relative to project root>:<line>:<column>` (1-based line, 0-based column).
 *
 * React keeps element props on the fiber (`memoizedProps`), so the inspector can read the JSX
 * call site of any element in the tree without relying on React's removed `_debugSource`
 * (React 19 no longer records `__source`).
 */
export const SOURCE_PROP = "__aiSource";

export interface InspectorTransformOptions {
  /** Force-enable/disable. Default: enabled unless the Metro caller reports a production build. */
  enabled?: boolean;
  /** Project root used to relativize paths. Default: Babel `root`/`cwd`. */
  root?: string;
  /** Extra path substrings to skip (node_modules is always skipped). */
  exclude?: string[];
}

interface State extends PluginPass {
  opts: InspectorTransformOptions;
  aiRelativeFile?: string | null;
}

const FRAGMENT_NAMES = new Set(["Fragment", "React.Fragment"]);

function jsxName(t: typeof BabelTypes, name: BabelTypes.JSXOpeningElement["name"]): string | null {
  if (t.isJSXIdentifier(name)) return name.name;
  if (t.isJSXMemberExpression(name)) {
    const object = jsxName(t, name.object);
    return object ? `${object}.${name.property.name}` : null;
  }
  return null; // namespaced names (a:b) are not React components
}

export function toPosixRelative(root: string, filename: string): string {
  const relative = path.relative(root, filename);
  return relative.split(path.sep).join("/");
}

export default function inspectorTransform(
  api: { types: typeof BabelTypes; caller?: <T>(fn: (caller: { isDev?: boolean } | undefined) => T) => T },
  pluginOptions: InspectorTransformOptions = {},
): PluginObj<State> {
  const t = api.types;
  // Metro passes `isDev` through the Babel caller. Calling api.caller also keys Babel's cache on it.
  const callerIsDev = typeof api.caller === "function" ? api.caller((caller) => caller?.isDev) : undefined;
  const enabled =
    pluginOptions.enabled ??
    (callerIsDev === false ? false : process.env.NODE_ENV !== "production" || callerIsDev === true);

  return {
    name: "expo-ai-inspector-transform",
    pre() {
      this.aiRelativeFile = null;
      if (!enabled) return;
      const filename = this.file.opts.filename;
      if (!filename) return;
      const normalized = filename.split(path.sep).join("/");
      if (normalized.includes("/node_modules/")) return;
      // The inspector's own UI (e.g. when linked from a workspace) must not look like app code.
      if (/\/expo-ai-inspector\/(src|build)\//.test(normalized)) return;
      if (this.opts.exclude?.some((pattern) => normalized.includes(pattern))) return;
      const root = this.opts.root ?? this.file.opts.root ?? this.file.opts.cwd ?? process.cwd();
      const relative = toPosixRelative(root, filename);
      // Files outside the project root (e.g. linked workspace packages) keep a stable relative path.
      this.aiRelativeFile = relative;
    },
    visitor: {
      JSXOpeningElement(nodePath: NodePath<BabelTypes.JSXOpeningElement>, state: State) {
        const file = state.aiRelativeFile;
        if (!file) return;
        const { node } = nodePath;
        const name = jsxName(t, node.name);
        if (!name) return;
        // Lowercase names are host/DOM intrinsics on web; unknown attributes would leak to the DOM.
        if (/^[a-z]/.test(name) && !name.includes(".")) return;
        if (FRAGMENT_NAMES.has(name)) return;
        const alreadyTagged = node.attributes.some(
          (attribute) => t.isJSXAttribute(attribute) && t.isJSXIdentifier(attribute.name, { name: SOURCE_PROP }),
        );
        if (alreadyTagged) return;
        const loc = node.loc?.start;
        if (!loc) return; // never fabricate a location
        // Appended last so it wins over `{...props}` spreads forwarded from a parent.
        node.attributes.push(
          t.jsxAttribute(t.jsxIdentifier(SOURCE_PROP), t.stringLiteral(`${file}:${loc.line}:${loc.column}`)),
        );
      },
    },
  };
}
