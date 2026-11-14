import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorktree } from "../src/worktree.js";

describe("resolveWorktree", () => {
  const main = resolve("main");
  const linked = resolve("linked");
  it("maps a linked root and a subdirectory to the main checkout", async () => {
    const runner = async () => `${resolve(main, ".git")}\n${linked}\n`;
    expect(await resolveWorktree(linked, runner)).toBe(main);
    expect(await resolveWorktree(resolve(linked, "app"), runner)).toBe(resolve(main, "app"));
  });
  it("keeps the main checkout unchanged", async () => {
    expect(await resolveWorktree(main, async () => `${resolve(main, ".git")}\n${main}`)).toBe(main);
  });
  it("keeps non-repositories and missing git unchanged", async () => {
    expect(
      await resolveWorktree(linked, async () => {
        throw new Error("git failed");
      }),
    ).toBe(linked);
  });
});
