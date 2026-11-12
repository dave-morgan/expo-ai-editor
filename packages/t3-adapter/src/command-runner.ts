import { spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";

import { AdapterProtocolError, AdapterUnavailableError } from "./agent-adapter.js";

export type CommandRunner = (
  args: string[],
  opts: { stdin?: string; timeoutMs: number },
) => Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>;

export function quoteWindowsCommand(command: string, args: string[]): string {
  return [command, ...args]
    .map((argument) => {
      if (!/^[A-Za-z0-9._:/\\ @=-]+$/.test(argument)) {
        throw new AdapterProtocolError("Unsafe character in Windows T3 CLI argument");
      }
      return `"${argument}"`;
    })
    .join(" ");
}

export function createCommandRunner(
  cli: { command: string; prefixArgs: string[] },
  options: { env?: NodeJS.ProcessEnv } = {},
): CommandRunner {
  return async (args, opts) => {
    const allArgs = [...cli.prefixArgs, ...args];
    const shellLauncher = process.platform === "win32" && /\.(cmd|bat)$/i.test(cli.command);
    const env = { ...process.env, ...options.env };
    const command = shellLauncher ? env.ComSpec || env.COMSPEC || "cmd.exe" : cli.command;
    const commandArgs = shellLauncher
      ? ["/d", "/s", "/c", `"${quoteWindowsCommand(cli.command, allArgs)}"`]
      : allArgs;
    return await new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const child = spawn(command, commandArgs, {
        env,
        windowsHide: true,
        windowsVerbatimArguments: shellLauncher,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const timer = setTimeout(() => {
        timedOut = true;
        if (shellLauncher && child.pid) {
          const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
            windowsHide: true,
            stdio: "ignore",
          });
          killer.on("error", () => child.kill());
          killer.on("close", () => child.kill());
        } else child.kill();
      }, opts.timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (cause) => {
        clearTimeout(timer);
        reject(new AdapterUnavailableError(`Could not start T3 CLI: ${cause.message}`, { cause }));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({
          code,
          stdout: stripVTControlCharacters(stdout),
          stderr: stripVTControlCharacters(stderr),
          timedOut,
        });
      });
      child.stdin.on("error", (cause: NodeJS.ErrnoException) => {
        if (cause.code !== "EPIPE" && cause.code !== "ERR_STREAM_DESTROYED") {
          clearTimeout(timer);
          child.kill();
          reject(
            new AdapterUnavailableError(`Could not write to T3 CLI: ${cause.message}`, { cause }),
          );
        }
      });
      child.stdin.end(opts.stdin);
    });
  };
}
