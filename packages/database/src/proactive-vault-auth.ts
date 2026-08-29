/** CAP-033 loopback API device authentication token. */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { defaultProactiveVaultKeyPath } from "./proactive-vault-crypto.js";

export interface ProactiveAccessTokenConfig {
  readonly token?: string;
  readonly tokenPath?: string;
}

export function defaultProactiveAccessTokenPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(path.dirname(defaultProactiveVaultKeyPath(env)), "proactive-access.token");
}

function validateToken(value: string): string {
  const token = value.trim();
  if (token.length < 32 || token.length > 256) {
    throw new Error("proactive access token must contain 32-256 characters");
  }
  return token;
}

async function readToken(tokenPath: string): Promise<string> {
  return validateToken(await readFile(tokenPath, "utf8"));
}

/** Load or create the owner-only token required by every /v1/proactive request. */
export async function loadProactiveAccessToken(
  config: ProactiveAccessTokenConfig = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const explicit = config.token ?? env.AERVOX_PROACTIVE_ACCESS_TOKEN;
  if (explicit) return validateToken(explicit);
  const tokenPath = config.tokenPath
    ?? env.AERVOX_PROACTIVE_ACCESS_TOKEN_PATH
    ?? defaultProactiveAccessTokenPath(env);
  try {
    return await readToken(tokenPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await mkdir(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
  const generated = randomBytes(32).toString("base64url");
  try {
    const handle = await open(tokenPath, "wx", 0o600);
    try {
      await handle.writeFile(`${generated}\n`, "utf8");
    } finally {
      await handle.close();
    }
    await chmod(tokenPath, 0o600).catch(() => undefined);
    return generated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return readToken(tokenPath);
  }
}
