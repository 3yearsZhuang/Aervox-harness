import { createHash, randomUUID } from "node:crypto";
import type { ConversationCryptoPort } from "./conversation-host-port.js";

export const nodeConversationCrypto: ConversationCryptoPort = Object.freeze({
  sha256Utf8: (value: string): string => createHash("sha256").update(value).digest("hex"),
  randomUUID,
});
