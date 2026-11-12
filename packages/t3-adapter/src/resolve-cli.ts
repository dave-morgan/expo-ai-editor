import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CliConfig {
  command: string;
  args?: string[];
}
export interface ResolvedCli {
  command: string;
  prefixArgs: string[];
  source: "config" | "env" | "path" | "home";
}
export interface ResolveCliOptions {
  cli?: CliConfig;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
}

async function executable(path: string, platform: NodeJS.Platform) {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveCli(options: ResolveCliOptions = {}): Promise<ResolvedCli | null> {
  if (options.cli)
    return { command: options.cli.command, prefixArgs: options.cli.args ?? [], source: "config" };
  const env = options.env ?? process.env;
  if (env.T3_CLI?.trim()) return { command: env.T3_CLI.trim(), prefixArgs: [], source: "env" };
  const platform = options.platform ?? process.platform;
  const windows = platform === "win32";
  const path = env.PATH ?? env.Path ?? env.path ?? "";
  const extensions = windows
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  for (const directory of path.split(windows ? ";" : ":").filter(Boolean)) {
    const unquoted = directory.replace(/^"(.*)"$/, "$1");
    for (const extension of extensions) {
      const command = join(unquoted, `t3${extension.toLowerCase()}`);
      if (await executable(command, platform)) return { command, prefixArgs: [], source: "path" };
    }
  }
  const home = options.homeDir ?? env.USERPROFILE ?? env.HOME ?? homedir();
  for (const name of windows ? ["t3.cmd", "t3"] : ["t3", "t3.cmd"]) {
    const command = join(home, ".t3", "bin", name);
    if (await executable(command, platform)) return { command, prefixArgs: [], source: "home" };
  }
  return null;
}
