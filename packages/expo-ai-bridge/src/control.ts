import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
import type { BridgeConfig } from "./config.js";

const controlSchema = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
  host: z.string().min(1),
  secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export function controlFile(config: BridgeConfig, port = config.port) {
  return resolve(
    config.pairing.controlDir ?? resolve(homedir(), ".expo-ai-bridge"),
    `control-${port}.json`,
  );
}
export function matchesControlSecret(candidate: string, expected: string) {
  return timingSafeEqual(
    createHash("sha256").update(candidate).digest(),
    createHash("sha256").update(expected).digest(),
  );
}
export async function writeControlFile(config: BridgeConfig, port: number, secret: string) {
  const directory = resolve(config.pairing.controlDir ?? resolve(homedir(), ".expo-ai-bridge"));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const path = controlFile(config, port);
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(
      temporary,
      JSON.stringify({ pid: process.pid, port, host: config.host, secret }),
      { mode: 0o600 },
    );
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return async () => {
    try {
      const current = controlSchema.parse(JSON.parse(await readFile(path, "utf8")));
      if (current.secret === secret) await rm(path, { force: true });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  };
}
export async function requestPairingCode(config: BridgeConfig) {
  try {
    const control = controlSchema.parse(JSON.parse(await readFile(controlFile(config), "utf8")));
    if (control.port !== config.port) throw new Error("Control port does not match configuration");
    const response = await fetch(`http://127.0.0.1:${control.port}/control/pairing-code`, {
      method: "POST",
      headers: { "x-expo-ai-control": control.secret },
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return z
      .object({ code: z.string().regex(/^\d{6}$/), expiresAt: z.string().datetime() })
      .parse(await response.json());
  } catch (cause) {
    throw new Error(
      `Cannot get a pairing code. Is expo-ai-bridge running on port ${config.port}? Start the bridge with the same config and port.`,
      { cause },
    );
  }
}
