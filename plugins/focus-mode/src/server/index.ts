/**
 * Aervox｜思隅 plugins/focus-mode — 服务端注册单元（CR-060）
 *
 * 宿主组合根以容错方式加载本模块，并在插件启用时装配其全部贡献。
 * 这里是「插件对宿主的唯一输出面」：宿主不 import 本目录下的任何私有文件。
 */
import type { ServerPluginRegistration } from "@aervox/host-plugin-api";
import { focusModeTurnPlugin } from "./turn-plugin.js";

export const focusModeRegistration: ServerPluginRegistration = {
  pluginId: "focus-mode",
  turnPlugins: [focusModeTurnPlugin],
};

export default focusModeRegistration;

export * from "./turn-plugin.js";
export * from "./prompt.js";
