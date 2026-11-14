import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { withExpoAI as WithExpoAI } from "../metro.js";
const { withExpoAI }: { withExpoAI: typeof WithExpoAI } = createRequire(import.meta.url)(
  "../metro.js",
);

describe("withExpoAI", () => {
  it("preserves existing resolver config and block lists without mutation", () => {
    for (const existing of [undefined, /original/, [/one/, /two/]]) {
      const config = {
        projectRoot: resolve("project (test)"),
        resolver: { blockList: existing, extra: true },
      };
      const result = withExpoAI(config);
      expect(result).not.toBe(config);
      expect(result.resolver).not.toBe(config.resolver);
      expect(config.resolver.blockList).toBe(existing);
      expect(result.resolver.extra).toBe(true);
      expect(result.resolver.blockList.slice(0, -1)).toEqual(
        existing === undefined ? [] : Array.isArray(existing) ? existing : [existing],
      );
    }
  });
  it("blocks escaped absolute directory paths with either separator and directory boundaries", () => {
    const root = resolve("project (test)");
    const config = withExpoAI(
      { projectRoot: root },
      { exclude: ["vendor/repo", resolve("outside")] },
    );
    for (const [index, directory] of [
      resolve(root, ".expo-ai"),
      resolve(root, "vendor/repo"),
      resolve("outside"),
    ].entries()) {
      const pattern = config.resolver.blockList[index]!;
      for (const separator of ["/", "\\"]) {
        const normalized = directory.replace(/[\\/]/g, separator);
        expect(pattern.test(`${normalized}${separator}shot.jpg`)).toBe(true);
        expect(pattern.test(`${normalized}-other${separator}shot.jpg`)).toBe(false);
      }
    }
  });
  it.skipIf(process.platform !== "win32")(
    "blocks UNC paths without collapsing the server prefix",
    () => {
      const root = String.raw`\\server\share\app`;
      const pattern = withExpoAI({ projectRoot: root }).resolver.blockList[0]!;
      expect(pattern.test(String.raw`\\server\share\app\.expo-ai\shot.jpg`)).toBe(true);
      expect(pattern.test("//server/share/app/.expo-ai/shot.jpg")).toBe(true);
    },
  );
  it("uses cwd when no project root is supplied", () => {
    expect(withExpoAI({}).resolver.blockList[0]!.test(resolve(".expo-ai/shot.jpg"))).toBe(true);
  });
});
