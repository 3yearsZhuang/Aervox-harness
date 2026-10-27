/** The accepted business intent, independent of transport IDs and execution host. */
import { conversationSha256, type ConversationCryptoPort } from "./conversation-host-port.js";
import type { CreateTurnRequest } from "@aervox/contracts";
import type { ConversationExecutionPolicy } from "@aervox/schema";
import { DomainConflictError } from "./errors.js";
import { assertConversationExecutionPolicy } from "./conversation-execution-policy.js";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type TurnIntentMessage = Omit<CreateTurnRequest["message"], "contentType"> & { contentType?: "text" | "markdown" };
export interface TurnIntentInput {
  sessionId: string;
  message: TurnIntentMessage;
  references?: CreateTurnRequest["references"];
  metadata?: Record<string, unknown>;
  toolApprovalMode?: "ask" | "full_access";
}

export class TurnIntentConflictError extends DomainConflictError {
  constructor(readonly reason: "intent_mismatch" | "intent_unavailable" | "session_mismatch") {
    super(`turn_${reason}`);
    this.name = "TurnIntentConflictError";
  }
}

/** Strict JSON only: unsupported values must not collapse to a different valid intent. */
function json(value: unknown, seen = new Set<object>()): Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || !value || seen.has(value)) throw new Error("invalid_turn_intent_json");
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("invalid_turn_intent_json");
  seen.add(value);
  try {
    if (Array.isArray(value)) return Array.from(value, item => json(item, seen));
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, json((value as Record<string, unknown>)[key], seen)]));
  } finally { seen.delete(value); }
}

/** The same policy normalization is used before dispatch and inside the writer transaction. */
export function normalizeTurnIntent(input: TurnIntentInput, policy: ConversationExecutionPolicy, trustedActorId?: string) {
  assertConversationExecutionPolicy(policy);
  const bot = policy !== "local-v1";
  const metadata = bot || input.metadata === undefined ? {} : json(input.metadata) as Record<string, Json>;
  return {
    version: 1 as const, sessionId: input.sessionId, executionPolicy: policy,
    message: {
      content: input.message.content, contentType: input.message.contentType ?? "text",
      attachments: (input.message.attachments ?? []).map(item => ({ attachmentId: item.attachmentId, name: item.name ?? null, mediaType: item.mediaType ?? null })),
    },
    references: (input.references ?? []).map(item => ({ sourceId: item.sourceId, sourceVersion: item.sourceVersion })),
    metadata, toolApprovalMode: bot ? "ask" as const : input.toolApprovalMode ?? "ask",
    actorId: trustedActorId ?? null,
  };
}
export type NormalizedTurnIntent = ReturnType<typeof normalizeTurnIntent>;
export interface AcceptedTurnParameters {
  userMessage: string;
  metadata: NormalizedTurnIntent["metadata"];
  toolApprovalMode: "ask" | "full_access";
  actorId?: string;
}

/** One versioned SHA-256 algorithm; JSON object order is irrelevant, array order is preserved. */
export function turnIntentHashWithHost(intent: NormalizedTurnIntent, crypto: Pick<ConversationCryptoPort, "sha256Utf8">): string {
  return `turn-intent-v1:${conversationSha256(crypto, JSON.stringify(json(intent)))}`;
}

/** Rendering is separate from identity: Inbox messages are merged only after hashing. */
export function renderTurnIntentMessage(intent: NormalizedTurnIntent): string {
  if (!intent.message.attachments.length) return intent.message.content;
  const list = intent.message.attachments.map(item => `- ${item.name ?? item.attachmentId}${item.mediaType ? ` (${item.mediaType})` : ""} [id: ${item.attachmentId}]`).join("\n");
  return `${intent.message.content}\n\n[附件清单]\n${list}`;
}
