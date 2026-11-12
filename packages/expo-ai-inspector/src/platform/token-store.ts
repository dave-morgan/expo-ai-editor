import { MemoryTokenStore, type TokenStore } from "../bridge/client";
import { optional } from "./optional";

/**
 * Session tokens are stored in the device keychain/keystore via expo-secure-store when available,
 * otherwise in memory (re-pairing is then needed after a full reload). Tokens are short-lived,
 * scoped to one project and only valid against the developer's own bridge.
 */
export function createTokenStore(): TokenStore {
  const secure = optional.secureStore();
  const memory = new MemoryTokenStore();
  if (!secure) return memory;
  const safeKey = (key: string) => key.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200);
  return {
    async get(key) {
      try {
        return (await secure.getItemAsync(safeKey(key))) ?? (await memory.get(key));
      } catch {
        return memory.get(key);
      }
    },
    async set(key, value) {
      await memory.set(key, value);
      try {
        await secure.setItemAsync(safeKey(key), value);
      } catch {
        // the memory copy still works for this session
      }
    },
    async delete(key) {
      await memory.delete(key);
      try {
        await secure.deleteItemAsync(safeKey(key));
      } catch {
        // ignore
      }
    },
  };
}
