/** Shared conversation commands with explicit trusted host primitives. This
 * entry assembles no connection, scheduler, memory store or platform fallback.
 */
export { ConversationRepository, MAX_RESUME_CANDIDATE_LIMIT, MAX_STREAM_EVENT_PAGE_ROWS, MAX_STREAM_EVENT_PAGE_DATA_BYTES } from "./repositories/sqlite/conversation-repository-neutral.js";
export type { ConversationCryptoPort, ConversationHostPort } from "./conversation-host-port.js";
export { normalizeTurnIntent, renderTurnIntentMessage, turnIntentHashWithHost, TurnIntentConflictError } from "./conversation-turn-intent-neutral.js";
export type { TurnIntentInput, NormalizedTurnIntent, AcceptedTurnParameters } from "./conversation-turn-intent-neutral.js";
export { SessionHistoryReadError } from "./repositories/sqlite/conversation/history-page.js";
export { FencingMismatchError, DomainConflictError, RepositoryNotFoundError, RepositoryAccessViolationError } from "./errors.js";
export type { LocalContext } from "./local-context.js";
