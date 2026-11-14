#!/usr/bin/env node
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { T3CliAdapter } from "@dave-morgan/expo-ai-t3-adapter";
import type { AgentAdapter } from "@dave-morgan/expo-ai-t3-adapter";

import { isLoopbackHost, loadConfig, parseCliArgs } from "./config.js";
import type { BridgeConfig, BridgeProject } from "./config.js";
import { requestPairingCode } from "./control.js";
import { createBridge } from "./index.js";

const usage = `Usage: expo-ai-bridge [start|doctor|threads|pair-code] [options]

  --config <path>          Configuration file (default: expo-ai-bridge.config.json)
  --project-id <id>        Single project id, or project to list with threads
  --project-root <path>    Expo project directory
  --t3-project <id|path>   Existing T3 project id or directory
  --thread <id>           Default T3 thread
  --host <address>         Bind address (default: 127.0.0.1)
  --port <number>          HTTP and WebSocket port (default: 8790)
  --lan                   Bind to 0.0.0.0

While running in a terminal: p = new pairing code, t = threads, q = quit.`;

function makeAdapter(config: BridgeConfig): AgentAdapter {
  return new T3CliAdapter({
    ...(config.t3.command ? { cli: { command: config.t3.command, args: config.t3.args } } : {}),
    timeoutMs: config.t3.timeoutMs,
  });
}

async function printThreads(adapter: AgentAdapter, projects: BridgeProject[]): Promise<void> {
  for (const project of projects) {
    console.log(`${project.name} (${project.id})`);
    const threads = await adapter.listThreads(project.t3Project);
    const allowed = project.allowedThreadIds;
    const available = threads.filter((thread) => !allowed || allowed.includes(thread.threadId));
    if (available.length === 0)
      console.log("  No available threads. Open or create a thread in T3 Code.");
    for (const thread of available) {
      console.log(`  ${thread.threadId}  ${thread.status}  ${thread.title}`);
    }
  }
}

function serverUrls(host: string, port: number): string[] {
  const hosts =
    host === "0.0.0.0"
      ? [
          "127.0.0.1",
          ...Object.values(networkInterfaces()).flatMap((entries) =>
            (entries ?? [])
              .filter((entry) => entry.family === "IPv4" && !entry.internal)
              .map((entry) => entry.address),
          ),
        ]
      : [host];
  return [...new Set(hosts)].map(
    (address) => `http://${address.includes(":") ? `[${address}]` : address}:${port}`,
  );
}

async function start(config: BridgeConfig, adapter: AgentAdapter): Promise<void> {
  const bridge = createBridge(config, { adapter });
  const address = await bridge.start();
  for (const url of serverUrls(address.host, address.port)) console.log(`Bridge: ${url}`);
  const printCode = () => {
    const pairing = bridge.getPairingCode();
    console.log(`Pairing code: ${pairing.code} (expires ${pairing.expiresAt.toISOString()})`);
  };
  printCode();

  await new Promise<void>((resolveStopped, rejectStopped) => {
    let stopping = false;
    const interactive = Boolean(process.stdin.isTTY);
    const wasRaw = process.stdin.isRaw;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      process.removeListener("SIGINT", shutdown);
      process.removeListener("SIGTERM", shutdown);
      if (interactive) {
        process.stdin.removeListener("data", onInput);
        process.stdin.setRawMode(wasRaw);
        process.stdin.pause();
      }
      void bridge.stop().then(resolveStopped, rejectStopped);
    };
    const onInput = (data: Buffer) => {
      for (const key of data.toString("utf8")) {
        if (key === "q" || key === "\u0003") shutdown();
        else if (key === "p") {
          bridge.regeneratePairingCode();
        } else if (key === "t") {
          void printThreads(adapter, config.projects).catch((error: unknown) => {
            console.error(error instanceof Error ? error.message : String(error));
          });
        }
      }
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    if (interactive) {
      console.log("Keys: p = new pairing code, t = threads, q = quit");
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("data", onInput);
    }
  });
}

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage);
    return;
  }
  const parsed = parseCliArgs(args);
  const config = await loadConfig({ configPath: parsed.configPath, flags: parsed.flags });
  if (parsed.command === "pair-code") {
    const pairing = await requestPairingCode(config);
    console.log(`Pairing code: ${pairing.code} (expires ${pairing.expiresAt})`);
    return;
  }
  if (parsed.command === "start" || parsed.command === "doctor") {
    for (const project of config.projects)
      if (project.t3ProjectWorktree)
        console.log(
          `T3 project: ${project.t3ProjectWorktree} \u2192 ${project.t3Project} (git worktree)`,
        );
  }
  if (parsed.command !== "start" && !isLoopbackHost(config.host)) {
    console.warn(
      "Warning: bridge reachable from your network; pairing token required; never expose to the internet",
    );
  }
  const adapter = makeAdapter(config);
  if (parsed.command === "start") {
    await start(config, adapter);
    return;
  }
  const projects = parsed.flags.projectId
    ? config.projects.filter((project) => project.id === parsed.flags.projectId)
    : config.projects;
  if (projects.length === 0) throw new Error(`Unknown project: ${parsed.flags.projectId}`);
  if (parsed.command === "threads") {
    await printThreads(adapter, projects);
    return;
  }
  let ok = true;
  for (const project of projects) {
    console.log(`Checking ${project.name} (${project.id})`);
    const report = await adapter.diagnose();
    ok &&= report.ok;
    for (const check of report.checks) {
      console.log(`  ${check.ok ? "OK" : "FAIL"} ${check.name}: ${check.detail}`);
      if (!check.ok && check.fix) console.log(`    Fix: ${check.fix}`);
    }
    try {
      await printThreads(adapter, [project]);
    } catch (error) {
      ok = false;
      console.error(error instanceof Error ? error.message : String(error));
      console.error(
        "Fix: Start T3 Code, add this project in T3 Code, and check its t3Project setting.",
      );
    }
  }
  if (!ok) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
