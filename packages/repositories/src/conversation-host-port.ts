/** Trusted synchronous primitives supplied by the execution host. Hashing must
 * compute SHA-256 over UTF-8 bytes without I/O; no digest or no-op defaults exist.
 */
export interface ConversationCryptoPort {
  sha256Utf8(value: string): string;
  randomUUID(): string;
}
export interface ConversationHostPort extends ConversationCryptoPort {
  /** Best-effort optimization after commit. Durable Outbox remains authoritative. */
  wakeOutbox(): void | boolean | Promise<void | boolean>;
}

export function requireConversationCrypto(port: ConversationCryptoPort): void {
  if (!port || typeof port.sha256Utf8 !== "function" || typeof port.randomUUID !== "function") {
    throw new Error("conversation_crypto_port_required");
  }
}
export function requireConversationHost(port: ConversationHostPort): void {
  requireConversationCrypto(port);
  if (typeof port.wakeOutbox !== "function") throw new Error("conversation_wakeup_port_required");
}
export function conversationSha256(port: Pick<ConversationCryptoPort, "sha256Utf8">, value: string): string {
  const digest = port.sha256Utf8(value);
  if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) {
    // Miswired async primitives remain invalid. Observe their eventual failure
    // so rejecting the command cannot leave a detached unhandled rejection.
    void Promise.resolve(digest).catch(() => undefined);
    throw new Error("conversation_sha256_result_invalid");
  }
  return digest;
}
export function conversationUUID(port: Pick<ConversationCryptoPort, "randomUUID">): string {
  const value = port.randomUUID();
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) {
    void Promise.resolve(value).catch(() => undefined);
    throw new Error("conversation_uuid_result_invalid");
  }
  return value;
}
/** A notification failure cannot turn a committed acceptance into a failed one. */
export function wakeCommittedOutbox(port: Pick<ConversationHostPort, "wakeOutbox">): void {
  try { void Promise.resolve(port.wakeOutbox()).catch(() => undefined); }
  catch { /* The committed Outbox is still available for explicit host dispatch. */ }
}
