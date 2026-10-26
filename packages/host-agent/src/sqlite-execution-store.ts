/** Production composition wrapper. Keep the legacy constructor and exact
 * repository error identity while sharing the neutral adaptation logic.
 */
import type { SqliteConversationRepository, LocalContext } from "@aervox/repositories";
import { FencingMismatchError } from "@aervox/repositories";
import { ConversationExecutionStore, type ModelRunSink } from "./conversation-execution-store.js";
export type { ModelRunSink } from "./conversation-execution-store.js";

export class SqliteExecutionStore extends ConversationExecutionStore<LocalContext> {
  constructor(repo: SqliteConversationRepository, ctx: LocalContext, modelRunSink?: ModelRunSink) {
    super(repo, ctx, modelRunSink, { isFencingMismatchError: (error): error is Error => error instanceof FencingMismatchError });
  }
}
