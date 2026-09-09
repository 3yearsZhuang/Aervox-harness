/**
 * Aervox｜思隅 @aervox/api — 服务端会话回合插件注册表 (Server Turn Plugin Registry)
 */
import type { ServerTurnPlugin } from "./types.js";

export class ServerTurnPluginRegistry {
  private readonly plugins = new Map<string, ServerTurnPlugin>();

  register(plugin: ServerTurnPlugin): void {
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
