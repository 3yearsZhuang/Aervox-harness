import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { ServerPluginRegistration } from "@aervox/host-plugin-api";
import { SqliteBotRepository, SqliteExtensionRepository, loadProactiveVaultCipher, type AervoxDatabase, type ProactiveVaultCipher, type SqliteConversationRepository } from "@aervox/repositories";
import { isPluginEnabled } from "../plugins/index.js";
import type { ConversationHost } from "../../companion/conversation/index.js";
import { BotManager, type RegisteredBotAdapter } from "./manager.js";
import { registerBotRoutes } from "./routes.js";

export interface BotModuleOptions {
  start?: boolean;
  adapters?: RegisteredBotAdapter[];
  cipher?: ProactiveVaultCipher;
  pluginEnabled?: (id: string) => Promise<boolean>;
}
export function registerBotsModule(input: {
  app: FastifyInstance; db: AervoxDatabase; conversation: Pick<ConversationHost, "commands" | "queries">; registrations: () => ServerPluginRegistration[];
}, options: BotModuleOptions = {}) {
  const extensionRepo = new SqliteExtensionRepository(input.db);
  let cipher: Promise<ProactiveVaultCipher> | undefined;
  const manager = new BotManager({
    store: new SqliteBotRepository(input.db), conversation: input.conversation,
    adapters: () => options.adapters ?? input.registrations().flatMap(registration =>
      (registration.botAdapters ?? []).map(adapter => ({ pluginId: registration.pluginId, adapter }))),
    pluginEnabled: options.pluginEnabled ?? (id => isPluginEnabled(id, extensionRepo)),
    cipher: () => cipher ??= options.cipher ? Promise.resolve(options.cipher) : loadProactiveVaultCipher({
      encodedKey: process.env.AERVOX_BOT_KEY,
      keyPath: process.env.AERVOX_BOT_KEY_PATH ?? path.join(fileURLToPath(new URL("../../../../../../", import.meta.url)), "data/bot-credentials.key"),
      keyId: "bot-v1",
    }, {}),
  });
  registerBotRoutes(input.app, manager);
  if (options.start !== false) input.app.addHook("onReady", () => manager.start());
  input.app.addHook("onClose", () => manager.close());
  return manager;
}
export { BotManager } from "./manager.js";
