import type { FastifyInstance } from "fastify";
import type { SqliteConversationRepository } from "@aervox/repositories";
import { loadExecutionConfig } from "@aervox/config";
import { createConversationApplication } from "../src/modules/companion/conversation/application.js";
import { registerConversationRoutes as registerPortRoutes } from "../src/modules/companion/conversation/routes.js";
import type { ConversationRouteDeps, ConversationTurnInput } from "../src/modules/companion/conversation/execution.js";
export type { ConversationRouteDeps } from "../src/modules/companion/conversation/execution.js";
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
