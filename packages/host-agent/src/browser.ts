/** Neutral execution adaptation; native/browser hosts provide an authoritative
 * repository. Node orchestration, SQLite drivers and process adapters stay out.
 */
export { ConversationExecutionStore, type ModelRunSink } from "./conversation-execution-store.js";
export type {
  ConversationExecutionRepositoryPort,
  ConversationExecutionStoreOptions,
  ConversationStreamEventRow,
} from "./conversation-execution-repository-port.js";
