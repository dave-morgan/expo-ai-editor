import { transformSync } from "@babel/core";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import plugin from "../src/index";

const root = path.resolve("/project");

function run(code: string, filename = path.join(root, "src", "components", "Card.tsx"), options = {}, caller?: object) {
  return transformSync(code, {
    filename,
    root,
    babelrc: false,
    configFile: false,
    caller: (caller ?? { name: "test", isDev: true }) as never,
    plugins: ["@babel/plugin-syntax-jsx", [plugin, options]],
    presets: [["@babel/preset-typescript", { isTSX: true, allExtensions: true }]],
  })?.code;
}

describe("inspector-transform", () => {
  it("tags component elements with relative file, line and column", () => {
    const out = run(`export const Card = () => (\n  <View style={s}>\n    <Text>Hi</Text>\n  </View>\n);`);
    expect(out).toContain(`__aiSource="src/components/Card.tsx:2:2"`);
    expect(out).toContain(`__aiSource="src/components/Card.tsx:3:4"`);
  });

  it("tags member expressions and puts the attribute after spreads", () => {
    const out = run(`const a = <Stack.Screen {...props} name="x" />;`);
    expect(out).toMatch(/\{\.\.\.props\} name="x" __aiSource="src\/components\/Card\.tsx:1:10"/);
  });

  it("skips fragments, lowercase intrinsics and already-tagged elements", () => {
    const out = run(
      `const a = <><Fragment><React.Fragment><div /><View __aiSource="keep:1:0" /></React.Fragment></Fragment></>;`,
    );
    expect(out).not.toMatch(/Fragment __aiSource/);
    expect(out).not.toMatch(/<div __aiSource/);
    expect(out?.match(/__aiSource/g)).toHaveLength(1);
    expect(out).toContain(`__aiSource="keep:1:0"`);
  });

  it("does nothing for node_modules files", () => {
    const out = run(`const a = <View />;`, path.join(root, "node_modules", "lib", "x.tsx"));
    expect(out).not.toContain("__aiSource");
  });

  it("does not tag the inspector's own sources", () => {
    const out = run(`const a = <View />;`, path.join(root, "packages", "expo-ai-inspector", "src", "ui", "Panel.tsx"));
    expect(out).not.toContain("__aiSource");
  });

  it("does nothing in production builds", () => {
    const out = run(`const a = <View />;`, undefined, {}, { name: "metro", isDev: false });
    expect(out).not.toContain("__aiSource");
    expect(run(`const a = <View />;`, undefined, { enabled: false })).not.toContain("__aiSource");
  });

  it("honours exclude patterns", () => {
    const out = run(`const a = <View />;`, undefined, { exclude: ["/components/"] });
    expect(out).not.toContain("__aiSource");
  });
});
