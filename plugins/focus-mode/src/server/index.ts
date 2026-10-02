/**
 * Aervox｜思隅 plugins/focus-mode — 服务端注册单元（CR-060）
 *
 * 宿主组合根以容错方式加载本模块，并在插件启用时装配其全部贡献。
 * 这里是「插件对宿主的唯一输出面」：宿主不 import 本目录下的任何私有文件。
 */
import type { ServerPluginRegistration } from "@aervox/host-plugin-api";
import { focusModeTurnPlugin } from "./turn-plugin.js";
import {
  PLUGIN_ID,
  createFocusModeToolContributions,
  FOCUS_MODE_REPLAY_SCRIPT,
} from "./focus-tools.js";
import { focusModeExploreEndpoints } from "./terms-routes.js";
import { focusModeReportEndpoints } from "./practice-reports-routes.js";
import { registerFocusModeApiContract } from "./contracts.js";

// 模块加载即登记对外 API 契约（事件类型、投影白名单、OpenAPI 片段），
// 必须先于宿主文档生成与请求处理发生
registerFocusModeApiContract();

export const focusModeRegistration: ServerPluginRegistration = {
  pluginId: PLUGIN_ID,
  turnPlugins: [focusModeTurnPlugin],
  // 工具贡献按当前本地上下文构造（端口随上下文绑定）；宿主仅在插件启用时合入模型工具面
  toolContributions: (services) => createFocusModeToolContributions(services.learningFacts),
  httpEndpoints: [...focusModeExploreEndpoints, ...focusModeReportEndpoints],
  // 自带确定性夹具：宿主只负责按模式名分发，不在宿主内建插件领域脚本
  replayScripts: { "scripted-plugin": FOCUS_MODE_REPLAY_SCRIPT },
};

export default focusModeRegistration;

export * from "./turn-plugin.js";
export * from "./prompt.js";
export * from "./focus-tools.js";
export * from "./terms-extractor.js";
export * from "./contracts.js";
