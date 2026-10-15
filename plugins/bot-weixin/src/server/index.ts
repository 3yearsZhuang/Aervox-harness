import type { BotAdapterContribution, ServerPluginRegistration } from "@aervox/host-plugin-api";
import { WeixinAdapter } from "./weixin-adapter.js";

export const weixinBotAdapter: BotAdapterContribution = {
  id: "weixin",
  platform: "weixin",
  displayName: "微信私聊",
  capabilities: { directMessages: true, groupMessages: false, login: true, maxTextLength: 2000 },
  create: (context) => new WeixinAdapter(context),
};

const registration: ServerPluginRegistration = {
  pluginId: "bot-weixin",
  botAdapters: [weixinBotAdapter],
};
export default registration;
