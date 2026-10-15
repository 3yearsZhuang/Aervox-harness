import type { BotAdapterContribution, ServerPluginRegistration } from "@aervox/host-plugin-api";
import { OneBotAdapter } from "./onebot-adapter.js";

export const onebotBotAdapter: BotAdapterContribution = {
  id: "onebot",
  platform: "onebot",
  displayName: "QQ 群（OneBot v11）",
  capabilities: { directMessages: false, groupMessages: true, login: false, maxTextLength: 2000 },
  create: (context) => new OneBotAdapter(context),
};

const registration: ServerPluginRegistration = {
  pluginId: "bot-onebot",
  botAdapters: [onebotBotAdapter],
};
export default registration;
