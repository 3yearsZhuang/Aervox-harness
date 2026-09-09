/**
 * Aervox｜思隅 @aervox/api — 服务端会话回合插件注册表 (Server Turn Plugin Registry)
 */
import type { ServerTurnPlugin } from "./types.js";

export class ServerTurnPluginRegistry {
  private readonly plugins = new Map<string, ServerTurnPlugin>();

  register(plugin: ServerTurnPlugin): void {
    // 别名去重与互斥：若已注册 focus-mode，则忽略旧别名 study-mode 与 quiz-mode 的重复注册；
    // 反之，若新注册 focus-mode，则自动清理先前已注册的别名，防止执行翻倍
    if (plugin.id === "study-mode" || plugin.id === "quiz-mode") {
      if (this.plugins.has("focus-mode")) {
        return;
      }
    }
    if (plugin.id === "focus-mode") {
      this.plugins.delete("study-mode");
      this.plugins.delete("quiz-mode");
    }
    this.plugins.set(plugin.id, plugin);
  }

  unregister(id: string): void {
    this.plugins.delete(id);
  }

  get(id: string): ServerTurnPlugin | undefined {
    const direct = this.plugins.get(id);
    if (direct) return direct;
    if (id === "study-mode" || id === "quiz-mode") return this.plugins.get("focus-mode");
    return undefined;
  }

  getAll(): ServerTurnPlugin[] {
    return Array.from(this.plugins.values());
  }

  clear(): void {
    this.plugins.clear();
  }
}

export const defaultServerTurnPluginRegistry = new ServerTurnPluginRegistry();
