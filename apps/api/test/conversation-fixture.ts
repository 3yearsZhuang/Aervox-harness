import type { FastifyInstance } from "fastify";
import type { SqliteConversationRepository } from "@aervox/repositories";
import { loadExecutionConfig } from "@aervox/config";
import { createConversationApplication } from "@aervox/host-runtime-test/modules/companion/conversation/application";
import { registerConversationRoutes as registerPortRoutes } from "@aervox/host-runtime-test/modules/companion/conversation/routes";
import type { ConversationRouteDeps, ConversationTurnInput } from "@aervox/host-runtime-test/modules/companion/conversation/execution";
export type { ConversationRouteDeps } from "@aervox/host-runtime-test/modules/companion/conversation/execution";
/** Integration fixtures assemble real storage explicitly; production HTTP only receives the application Port. */
export function registerConversationRoutes(app: FastifyInstance, repo: SqliteConversationRepository,
  deps: Partial<ConversationRouteDeps> = {}, execute?: (input: ConversationTurnInput) => Promise<void>) {
  deps.executionConfig ??= loadExecutionConfig();
  const application = createConversationApplication(repo, deps as ConversationRouteDeps,
    execute ? (_ctx, input) => execute(input) : undefined);
  app.addHook("onClose", () => application.close());
  registerPortRoutes(app, application, deps);
  return application;
}
