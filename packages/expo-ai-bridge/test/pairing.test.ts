import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PairingManager } from "../src/pairing.js";

async function fixture() {
  let now = 1_000_000;
  const sessionsFile = join(
    await mkdtemp(join(tmpdir(), "bridge-pairing-")),
    "state",
    "sessions.json",
  );
  const config = { sessionsFile, codeTtlSeconds: 600, tokenTtlHours: 12 };
  const manager = await PairingManager.create({ config, projectIds: ["app"], now: () => now });
  return {
    manager,
    config,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}
const request = { projectId: "app", clientId: "device-one", deviceName: "Phone" };

describe("pairing", () => {
  it("allows multiple devices, authenticates project/client and persists hashes only", async () => {
    const { manager, config, now } = await fixture();
    const code = manager.getPairingCode().code;
    expect(code).toMatch(/^\d{6}$/);
    const paired = await manager.pair({ ...request, code }, "127.0.0.1");
    expect(paired.token).toMatch(/^[\w-]{43}$/);
    expect(manager.authenticate(paired.token, "app", "device-one")).toMatchObject(request);
    expect(manager.authenticate(paired.token, "other")).toBeNull();
    expect(manager.authenticate(paired.token, "app", "device-two")).toBeNull();
    await manager.pair({ ...request, clientId: "device-two", code }, "127.0.0.1");
    const persisted = await readFile(config.sessionsFile, "utf8");
    expect(persisted).not.toContain(paired.token);
    expect(persisted).not.toContain(code);
    const restored = await PairingManager.create({ config, projectIds: ["app"], now });
    expect(restored.authenticate(paired.token, "app")).not.toBeNull();
  });
  it("rejects wrong and expired codes, invalidating the code after ten failures", async () => {
    const { manager, advance } = await fixture();
    const code = manager.getPairingCode().code;
    const wrong = code === "000000" ? "999999" : "000000";
    for (let i = 0; i < 10; i++)
      await expect(manager.pair({ ...request, code: wrong }, `ip-${i}`)).rejects.toMatchObject({
        status: 401,
      });
    await expect(manager.pair({ ...request, code }, "fresh")).rejects.toMatchObject({
      status: 401,
    });
    const replacement = manager.regeneratePairingCode();
    await manager.pair({ ...request, code: replacement.code }, "fresh");
    advance(600_001);
    await expect(
      manager.pair({ ...request, code: replacement.code }, "fresh"),
    ).rejects.toMatchObject({ status: 401 });
  });
  it("limits each IP to five attempts per minute and rejects unknown projects", async () => {
    const { manager, advance } = await fixture();
    const code = manager.getPairingCode().code;
    for (let i = 0; i < 5; i++) await manager.pair({ ...request, code }, "same-ip");
    await expect(manager.pair({ ...request, code }, "same-ip")).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
    });
    advance(60_001);
    await manager.pair({ ...request, code }, "same-ip");
    await expect(
      manager.pair({ ...request, projectId: "unknown", code }, "another-ip"),
    ).rejects.toMatchObject({ status: 404, code: "unknown_project" });
  });
  it("expires tokens and prunes expired sessions on reload", async () => {
    const { manager, config, advance, now } = await fixture();
    const paired = await manager.pair({ ...request, code: manager.getPairingCode().code }, "ip");
    advance(12 * 3600_000 + 1);
    expect(manager.authenticate(paired.token, "app")).toBeNull();
    const restored = await PairingManager.create({ config, projectIds: ["app"], now });
    expect(restored.authenticate(paired.token, "app")).toBeNull();
    expect(await readFile(config.sessionsFile, "utf8")).not.toContain("device-one");
  });
});
