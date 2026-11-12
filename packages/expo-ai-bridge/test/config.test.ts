import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isLoopbackHost, loadConfig, parseCliArgs } from "../src/config.js";

describe("bridge config", () => {
  it("loads defaults and resolves paths against the config directory", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bridge-config-"));
    await mkdir(join(cwd, "settings"));
    await writeFile(
      join(cwd, "settings", "bridge.json"),
      JSON.stringify({ projects: [{ id: "app", name: "App", root: "../app", t3Project: "./t3" }] }),
    );
    const config = await loadConfig({ cwd, configPath: "settings/bridge.json" });
    expect(config).toMatchObject({
      host: "127.0.0.1",
      port: 8790,
      screenshots: { enabled: true, maxBytes: 4500000 },
      pairing: { codeTtlSeconds: 600, tokenTtlHours: 12 },
    });
    expect(config.projects[0]).toMatchObject({
      root: resolve(cwd, "app"),
      t3Project: resolve(cwd, "settings/t3"),
    });
  });
  it("merges network and project flags while retaining project ids as T3 refs", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bridge-config-"));
    const parsed = parseCliArgs([
      "start",
      "--project-id",
      "app",
      "--project-root",
      "./app",
      "--t3-project",
      "t3-id",
      "--thread",
      "mcp:one",
      "--lan",
      "--port",
      "0",
    ]);
    const config = await loadConfig({ cwd, ...parsed });
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(0);
    expect(config.projects[0]).toMatchObject({
      id: "app",
      root: resolve(cwd, "app"),
      t3Project: "t3-id",
      defaultThreadId: "mcp:one",
    });
  });
  it("rejects missing projects, malformed config, duplicate ids and invalid ports", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bridge-config-"));
    await expect(loadConfig({ cwd })).rejects.toThrow(/project|config/i);
    await writeFile(join(cwd, "expo-ai-bridge.config.json"), "{");
    await expect(loadConfig({ cwd })).rejects.toThrow();
    await writeFile(
      join(cwd, "expo-ai-bridge.config.json"),
      JSON.stringify({
        projects: [
          { id: "a", root: ".", t3Project: "." },
          { id: "a", root: ".", t3Project: "." },
        ],
      }),
    );
    await expect(loadConfig({ cwd })).rejects.toThrow(/duplicate/i);
    expect(() => parseCliArgs(["--port", "no"])).toThrow(/port/i);
  });
  it("keeps project selection flags from replacing the loaded project list", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bridge-config-"));
    await writeFile(
      join(cwd, "expo-ai-bridge.config.json"),
      JSON.stringify({ projects: [{ id: "a", root: ".", t3Project: "t3-project" }] }),
    );
    const config = await loadConfig({ cwd, flags: { projectId: "a" } });
    expect(config.projects[0]?.t3Project).toBe("t3-project");
    expect(parseCliArgs(["threads", "--project-id", "a"]).command).toBe("threads");
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("127.23.1.2")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
  });
  it("resolves configured launcher and session paths relative to the config", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bridge-config-"));
    await writeFile(
      join(cwd, "expo-ai-bridge.config.json"),
      JSON.stringify({
        projects: [{ id: "app", root: ".", t3Project: "." }],
        t3: { command: "./bin/t3.cmd" },
        pairing: { sessionsFile: "./state/sessions.json" },
      }),
    );
    const config = await loadConfig({ cwd });
    expect(config.t3.command).toBe(resolve(cwd, "bin/t3.cmd"));
    expect(config.pairing.sessionsFile).toBe(resolve(cwd, "state/sessions.json"));
  });
});
