import { execFile } from "node:child_process";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
export async function resolveWorktree(
  path: string,
  gitRunner: (path: string) => Promise<string> = async (path) =>
    (
      await run("git", [
        "-C",
        path,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
        "--show-toplevel",
      ])
    ).stdout,
): Promise<string> {
  try {
    const [commonDir, top] = (await gitRunner(path)).trim().split(/\r?\n/);
    if (!commonDir || !top || !isAbsolute(commonDir) || !isAbsolute(top)) return path;
    if (basename(commonDir) !== ".git" || resolve(commonDir) === resolve(top, ".git")) return path;
    const suffix = relative(top, path);
    if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) return path;
    return resolve(dirname(commonDir), suffix);
  } catch {
    // Git is optional; directories outside a repository keep their configured path.
    return path;
  }
}
