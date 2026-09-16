/**
 * Aervox｜思隅 @aervox/repositories — 主动画像 Vault 字段级加解密辅助
 */
import type { ProactiveVaultCipher } from "../../../proactive-vault-crypto.js";

export function encrypt(
  value: string | null | undefined,
  resourceType: string,
  resourceId: string,
  cipher?: ProactiveVaultCipher,
): string | null | undefined {
  if (value === null || value === undefined || !cipher) return value;
  if (cipher.isEncrypted(value)) return value;
  return cipher.encrypt(value, `${resourceType}:${resourceId}`);
}

export function decodeWithCipher(
  value: string | null | undefined,
  cipher: ProactiveVaultCipher | undefined,
  associatedData: string,
): string | null | undefined {
  if (value === null || value === undefined || !cipher || !cipher.isEncrypted(value)) return value;
  return cipher.decrypt(value, associatedData);
}
