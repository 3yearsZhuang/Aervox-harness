/**
 * CAP-033 主动画像本地 Vault 字段加密。
 *
 * SQLite 文件权限不是正文加密。该模块使用 AES-256-GCM 对原始捕获、画像正文和
 * 动作参数做应用层加密；授权状态、时间和不可逆 checksum 保持可查询。
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ENVELOPE_PREFIX = "avxenc:v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;

export interface ProactiveVaultCipher {
  readonly keyId: string;
  encrypt(plaintext: string, associatedData?: string): string;
  decrypt(envelope: string, associatedData?: string): string;
  isEncrypted(value: string): boolean;
}

export interface ProactiveVaultKeyConfig {
  /** 32-byte key encoded as base64/base64url. Prefer OS secret injection in packaged builds. */
  readonly encodedKey?: string;
  /** Local fallback key file. It is created with owner-only permissions. */
  readonly keyPath?: string;
  readonly keyId?: string;
}

function decodeKey(encoded: string): Buffer {
  const key = Buffer.from(encoded.trim(), "base64url");
  if (key.length !== KEY_BYTES) {
    throw new Error("proactive vault key must decode to exactly 32 bytes");
  }
  return key;
}

function assertKeyId(keyId: string): void {
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(keyId)) {
    throw new Error("proactive vault keyId contains unsupported characters");
  }
}

export function createProactiveVaultCipher(
  key: Uint8Array,
  keyId = "local-v1",
): ProactiveVaultCipher {
  if (key.byteLength !== KEY_BYTES) {
    throw new Error("proactive vault key must contain exactly 32 bytes");
  }
  assertKeyId(keyId);
  const keyBuffer = Buffer.from(key);

  return {
    keyId,
    encrypt(plaintext, associatedData = "") {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", keyBuffer, iv);
      if (associatedData) cipher.setAAD(Buffer.from(associatedData, "utf8"));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [
        ENVELOPE_PREFIX,
        keyId,
        iv.toString("base64url"),
        tag.toString("base64url"),
        ciphertext.toString("base64url"),
      ].join(":");
    },
    decrypt(envelope, associatedData = "") {
      const [prefix, version, envelopeKeyId, ivRaw, tagRaw, ciphertextRaw, extra] = envelope.split(":");
      if (`${prefix}:${version}` !== ENVELOPE_PREFIX || extra !== undefined) {
        throw new Error("invalid proactive vault encrypted envelope");
      }
      if (envelopeKeyId !== keyId || !ivRaw || !tagRaw || ciphertextRaw === undefined) {
        throw new Error("proactive vault envelope key mismatch");
      }
      const iv = Buffer.from(ivRaw, "base64url");
      const tag = Buffer.from(tagRaw, "base64url");
      if (iv.length !== IV_BYTES || tag.length !== 16) {
        throw new Error("invalid proactive vault encryption metadata");
      }
      const decipher = createDecipheriv("aes-256-gcm", keyBuffer, iv);
      if (associatedData) decipher.setAAD(Buffer.from(associatedData, "utf8"));
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertextRaw, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    },
    isEncrypted(value) {
      return value.startsWith(`${ENVELOPE_PREFIX}:`);
    },
  };
}

export function defaultProactiveVaultKeyPath(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Aervox", "proactive-vault.key");
  }
  if (process.platform === "win32") {
    return path.join(
      env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
      "Aervox",
      "proactive-vault.key",
    );
  }
  return path.join(
    env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"),
    "aervox",
    "proactive-vault.key",
  );
}

async function readPersistedKey(keyPath: string): Promise<Buffer> {
  return decodeKey(await readFile(keyPath, "utf8"));
}

/**
 * Load the local Vault key. Packaged hosts should inject an OS-protected key; development/local
 * fallback creates a 0600 key file outside the repository and common document sync folders.
 */
export async function loadProactiveVaultCipher(
  config: ProactiveVaultKeyConfig = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProactiveVaultCipher> {
  const keyId = config.keyId ?? env.AERVOX_PROACTIVE_VAULT_KEY_ID ?? "local-v1";
  const encodedKey = config.encodedKey ?? env.AERVOX_PROACTIVE_VAULT_KEY;
  if (encodedKey) return createProactiveVaultCipher(decodeKey(encodedKey), keyId);

  const keyPath = config.keyPath ?? env.AERVOX_PROACTIVE_VAULT_KEY_PATH ?? defaultProactiveVaultKeyPath(env);
  try {
    return createProactiveVaultCipher(await readPersistedKey(keyPath), keyId);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }

  await mkdir(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  const generated = randomBytes(KEY_BYTES);
  try {
    const handle = await open(keyPath, "wx", 0o600);
    try {
      await handle.writeFile(`${generated.toString("base64url")}\n`, "utf8");
    } finally {
      await handle.close();
    }
    await chmod(keyPath, 0o600).catch(() => undefined);
    return createProactiveVaultCipher(generated, keyId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return createProactiveVaultCipher(await readPersistedKey(keyPath), keyId);
  }
}
