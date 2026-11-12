import type { PairRequest, PairResponse } from "@expo-ai/protocol";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { BridgeConfig } from "./config.js";

const sessionSchema = z.object({
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  projectId: z.string(),
  clientId: z.string(),
  deviceName: z.string().optional(),
  expiresAt: z.number().finite(),
});
export type PairingSession = z.infer<typeof sessionSchema>;
interface PairingOptions {
  config: BridgeConfig["pairing"];
  projectIds: string[];
  now?: () => number;
  onCodeInvalidated?: () => void;
}
export class PairingError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: "unauthorized" | "rate_limited" | "unknown_project",
    message: string,
  ) {
    super(message);
    this.name = "PairingError";
  }
}

export class PairingManager {
  private readonly sessions = new Map<string, PairingSession>();
  private readonly attempts = new Map<string, number[]>();
  private readonly now: () => number;
  private code = "";
  private expiresAt = 0;
  private failures = 0;
  private persistence: Promise<void> = Promise.resolve();
  private constructor(private readonly options: PairingOptions) {
    this.now = options.now ?? Date.now;
    this.regeneratePairingCode();
  }

  static async create(options: PairingOptions) {
    const manager = new PairingManager(options);
    let data: unknown;
    try {
      data = JSON.parse(await readFile(options.config.sessionsFile, "utf8"));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (data !== undefined) {
      for (const session of z.array(sessionSchema).parse(data))
        if (session.expiresAt > manager.now() && options.projectIds.includes(session.projectId))
          manager.sessions.set(session.hash, session);
      await manager.persist();
    }
    return manager;
  }

  getPairingCode() {
    return { code: this.code, expiresAt: new Date(this.expiresAt) };
  }
  regeneratePairingCode() {
    this.code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    this.expiresAt = this.now() + this.options.config.codeTtlSeconds * 1000;
    this.failures = 0;
    return this.getPairingCode();
  }

  async pair(request: PairRequest, ip: string): Promise<PairResponse> {
    const now = this.now();
    for (const [address, attempts] of this.attempts)
      if (!attempts.some((at) => at > now - 60_000)) this.attempts.delete(address);
    const attempts = (this.attempts.get(ip) ?? []).filter((at) => at > now - 60_000);
    if (attempts.length >= 5)
      throw new PairingError(429, "rate_limited", "Too many pairing attempts; wait a minute");
    attempts.push(now);
    this.attempts.set(ip, attempts);
    if (!this.options.projectIds.includes(request.projectId))
      throw new PairingError(404, "unknown_project", "Unknown project");
    const candidate = createHash("sha256").update(request.code).digest();
    const expected = createHash("sha256").update(this.code).digest();
    const matches = timingSafeEqual(candidate, expected);
    if (!matches || now >= this.expiresAt || this.failures >= 10) {
      this.failures += 1;
      if (this.failures === 10) {
        this.expiresAt = 0;
        this.options.onCodeInvalidated?.();
      }
      throw new PairingError(401, "unauthorized", "Pairing code is invalid or expired");
    }
    const token = randomBytes(32).toString("base64url");
    const expiresAt = now + this.options.config.tokenTtlHours * 3600_000;
    const hash = createHash("sha256").update(token).digest("hex");
    this.sessions.set(hash, {
      hash,
      projectId: request.projectId,
      clientId: request.clientId,
      deviceName: request.deviceName,
      expiresAt,
    });
    await this.persist();
    return { token, expiresAt: new Date(expiresAt).toISOString(), projectId: request.projectId };
  }

  authenticate(token: string, projectId: string, clientId?: string) {
    const hash = createHash("sha256").update(token).digest("hex");
    const session = this.sessions.get(hash);
    if (
      !session ||
      session.expiresAt <= this.now() ||
      session.projectId !== projectId ||
      (clientId !== undefined && clientId !== session.clientId)
    )
      return null;
    return { ...session };
  }

  private persist() {
    const operation = async () => {
      const { sessionsFile } = this.options.config;
      await mkdir(dirname(sessionsFile), { recursive: true, mode: 0o700 });
      const temporary = `${sessionsFile}.${randomBytes(8).toString("hex")}.tmp`;
      await writeFile(
        temporary,
        JSON.stringify(
          [...this.sessions.values()].filter((session) => session.expiresAt > this.now()),
        ),
        { mode: 0o600 },
      );
      await chmod(temporary, 0o600);
      await rename(temporary, sessionsFile);
    };
    const next = this.persistence.then(operation, operation);
    this.persistence = next;
    return next;
  }
}
