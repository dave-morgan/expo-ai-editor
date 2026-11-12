import { RequestIdSchema } from "@expo-ai/protocol";
import type { Screenshot } from "@expo-ai/protocol";
import { constants } from "node:fs";
import { mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { BridgeConfig } from "./config.js";

export function validateScreenshot(screenshot: Screenshot, maxBytes: number) {
  if (screenshot.base64.length > Math.ceil(maxBytes / 3) * 4)
    throw new Error("Screenshot exceeds maximum size in bytes");
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(screenshot.base64) ||
    !screenshot.base64
  )
    throw new Error("Invalid screenshot base64");
  const bytes = Buffer.from(screenshot.base64, "base64");
  if (bytes.length > maxBytes) throw new Error("Screenshot exceeds maximum size in bytes");
  const magic =
    screenshot.mimeType === "image/jpeg"
      ? Buffer.from([0xff, 0xd8, 0xff])
      : Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < magic.length || !bytes.subarray(0, magic.length).equals(magic))
    throw new Error("Screenshot magic signature does not match its MIME type");
  return bytes;
}

function requireInside(root: string, candidate: string) {
  const path = relative(root, candidate);
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
    throw new Error("Screenshot path must stay inside the project root");
}

// Resolve every existing ancestor before creating its child: mkdir({recursive:true})
// would follow a symlink and could create directories outside the project first.
async function ensureInsideDirectory(root: string, directory: string) {
  requireInside(root, directory);
  let current = root;
  for (const part of relative(root, directory).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    try {
      await mkdir(current);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    const actual = await realpath(current);
    requireInside(root, actual);
    current = actual;
  }
  return current;
}

export async function saveScreenshot({
  projectRoot,
  requestId,
  screenshot,
  config,
}: {
  projectRoot: string;
  requestId: string;
  screenshot: Screenshot;
  config: BridgeConfig["screenshots"];
}) {
  if (!config.enabled) return undefined;
  RequestIdSchema.parse(requestId);
  const bytes = validateScreenshot(screenshot, config.maxBytes);
  const root = await realpath(projectRoot);
  const directory = await ensureInsideDirectory(root, resolve(root, config.dir));
  const ignoreDirectory = await ensureInsideDirectory(root, resolve(root, ".expo-ai"));
  const ignorePath = resolve(ignoreDirectory, ".gitignore");
  // O_EXCL rejects existing symbolic links, and O_NOFOLLOW protects supported OSes.
  try {
    const ignore = await open(
      ignorePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await ignore.writeFile("*\n");
    } finally {
      await ignore.close();
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    requireInside(root, await realpath(ignorePath));
    const ignore = await open(ignorePath, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      if (!(await ignore.stat()).isFile()) throw new Error("Screenshot ignore path must be a file");
      const content = await ignore.readFile("utf8");
      if (!content.split(/\r?\n/).some((line) => line.trim() === "*"))
        await ignore.writeFile(`${content.endsWith("\n") || !content ? "" : "\n"}*\n`);
    } finally {
      await ignore.close();
    }
  }
  const filename = `${requestId}.${screenshot.mimeType === "image/jpeg" ? "jpg" : "png"}`;
  const path = resolve(directory, filename);
  requireInside(root, path);
  const file = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(bytes);
  } finally {
    await file.close();
  }
  return relative(root, path).split(sep).join("/");
}
