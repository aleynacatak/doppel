import { safeStorage } from "electron";
import fs from "node:fs/promises";
import path from "node:path";

export type SecretName = "accessCode" | "metaApiKey" | "figmaToken";

/**
 * The demo access code and the own Meta API key, encrypted with Electron safeStorage
 * (macOS Keychain). Never written in plain text and never sent to the renderer.
 */
export class SecretStore {
  private readonly file: string;

  constructor(userData: string) {
    this.file = path.join(userData, "secrets.json");
  }

  available(): Promise<boolean> {
    return safeStorage.isAsyncEncryptionAvailable();
  }

  private async readAll(): Promise<Partial<Record<SecretName, string>>> {
    try {
      return JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch {
      return {};
    }
  }

  async get(name: SecretName): Promise<string | null> {
    const encrypted = (await this.readAll())[name];
    if (!encrypted || !(await this.available())) return null;
    const bytes = Buffer.from(encrypted, "base64");
    try {
      const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(bytes);
      if (shouldReEncrypt) await this.set(name, result);
      return result;
    } catch {
      // Saved by an earlier version with the old synchronous API: read it once and save it again.
      try {
        const value = safeStorage.decryptString(bytes);
        await this.set(name, value);
        return value;
      } catch {
        return null;
      }
    }
  }

  async set(name: SecretName, value: string | null): Promise<void> {
    const all = await this.readAll();
    if (value === null) {
      delete all[name];
    } else {
      if (!(await this.available())) throw new Error("Encryption isn't available on this Mac, so Doppl can't store secrets.");
      all[name] = (await safeStorage.encryptStringAsync(value)).toString("base64");
    }
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(all, null, 2), { encoding: "utf8", mode: 0o600 });
  }
}

/** "DOPPL-ABCD-EFGH-JK23" → "…JK23" */
export const secretHint = (value: string | null) => (value ? `…${value.trim().slice(-4)}` : null);
