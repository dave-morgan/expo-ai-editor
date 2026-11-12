import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Screenshot } from "@expo-ai/protocol";
import { describe, expect, it } from "vitest";
import { saveScreenshot, validateScreenshot } from "../src/screenshot.js";

const jpeg: Screenshot = {
  mimeType: "image/jpeg",
  base64: Buffer.from([255, 216, 255, 0]).toString("base64"),
  width: 1,
  height: 1,
  scale: 1,
};
const config = { enabled: true, dir: ".expo-ai/screenshots", maxBytes: 100 };
describe("screenshot safety", () => {
  it("checks matching JPEG/PNG magic bytes, strict base64 and decoded size", () => {
    expect(validateScreenshot(jpeg, 100)).toEqual(Buffer.from([255, 216, 255, 0]));
    const png = {
      ...jpeg,
      mimeType: "image/png",
      base64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64"),
    } satisfies Screenshot;
    expect(validateScreenshot(png, 100).length).toBe(8);
    expect(() => validateScreenshot({ ...jpeg, mimeType: "image/png" }, 100)).toThrow(
      /signature|magic|PNG/i,
    );
    expect(() => validateScreenshot({ ...jpeg, base64: "@@@!" }, 100)).toThrow(/base64/i);
    expect(() => validateScreenshot(jpeg, 3)).toThrow(/size|large|bytes/i);
  });
  it("writes under the root, makes ignore file and skips disabled screenshots", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-shot-"));
    const path = await saveScreenshot({
      projectRoot: root,
      requestId: "request_123",
      screenshot: jpeg,
      config,
    });
    expect(path).toBe(".expo-ai/screenshots/request_123.jpg");
    expect(await readFile(join(root, path!), "hex")).toBe("ffd8ff00");
    expect(await readFile(join(root, ".expo-ai/.gitignore"), "utf8")).toContain("*");
    expect(
      await saveScreenshot({
        projectRoot: root,
        requestId: "request_124",
        screenshot: jpeg,
        config: { ...config, enabled: false },
      }),
    ).toBeUndefined();
  });
  it("rejects traversal in directory and request id", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-shot-"));
    await expect(
      saveScreenshot({ projectRoot: root, requestId: "../outside", screenshot: jpeg, config }),
    ).rejects.toThrow();
    await expect(
      saveScreenshot({
        projectRoot: root,
        requestId: "request_123",
        screenshot: jpeg,
        config: { ...config, dir: "../outside" },
      }),
    ).rejects.toThrow(/inside|outside|contain/i);
  });
  it("rejects symlink escapes before creating descendant directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-shot-"));
    const outside = await mkdtemp(join(tmpdir(), "bridge-outside-"));
    await symlink(outside, join(root, ".expo-ai"), "junction");
    await expect(
      saveScreenshot({ projectRoot: root, requestId: "request_123", screenshot: jpeg, config }),
    ).rejects.toThrow(/inside|outside|contain/i);
    await mkdir(join(root, "safe"));
    await symlink(outside, join(root, "safe", "escape"), "junction");
    await expect(
      saveScreenshot({
        projectRoot: root,
        requestId: "request_123",
        screenshot: jpeg,
        config: { ...config, dir: "safe/escape/deep" },
      }),
    ).rejects.toThrow(/inside|outside|contain/i);
  });
  it("rejects an existing screenshot symlink and ignore-file symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-shot-"));
    const outside = await mkdtemp(join(tmpdir(), "bridge-outside-"));
    await mkdir(join(root, ".expo-ai/screenshots"), { recursive: true });
    await symlink(outside, join(root, ".expo-ai/screenshots/request_123.jpg"), "junction");
    await expect(
      saveScreenshot({ projectRoot: root, requestId: "request_123", screenshot: jpeg, config }),
    ).rejects.toThrow();
  });
  it("adds the wildcard to an existing ignore file without losing its contents", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-shot-"));
    await mkdir(join(root, ".expo-ai"));
    await writeFile(join(root, ".expo-ai/.gitignore"), "# Existing rule\n*.tmp");
    await saveScreenshot({ projectRoot: root, requestId: "request_123", screenshot: jpeg, config });
    const ignore = await readFile(join(root, ".expo-ai/.gitignore"), "utf8");
    expect(ignore).toContain("# Existing rule\n*.tmp");
    expect(ignore.split(/\r?\n/)).toContain("*");
  });
  it("rejects an ignore-file symlink escaping the root", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-shot-"));
    const outside = await mkdtemp(join(tmpdir(), "bridge-outside-"));
    await mkdir(join(root, ".expo-ai"));
    await symlink(outside, join(root, ".expo-ai/.gitignore"), "junction");
    await expect(
      saveScreenshot({ projectRoot: root, requestId: "request_123", screenshot: jpeg, config }),
    ).rejects.toThrow(/inside|outside|contain/i);
  });
});
