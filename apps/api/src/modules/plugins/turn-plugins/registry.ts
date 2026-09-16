/**
 * Aervox｜思隅 @aervox/api — 服务端插件注册表 (Server Plugin Registry)
 *
 * 统一管理服务端插件生命周期、回合切面与声明式别名体系。
 */
import type { ServerPlugin, ServerTurnPlugin } from "./types.js";

export const DEFAULT_BUILTIN_ALIASES: Record<string, string[]> = {
  "focus-mode": ["study-mode", "quiz-mode"],
};

export class ServerPluginRegistry {
  private readonly plugins = new Map<string, ServerPlugin>();
  /** 别名索引：alias -> primaryPluginId */
  private readonly aliasMap = new Map<string, string>();

  constructor(builtinAliases: Record<string, string[]> = DEFAULT_BUILTIN_ALIASES) {
    for (const [primaryId, aliases] of Object.entries(builtinAliases)) {
      for (const alias of aliases) {
        this.aliasMap.set(alias, primaryId);
      }
    }
  }

  register(plugin: ServerPlugin): void {
    const primaryId = this.aliasMap.get(plugin.id);
    // 1. 若当前插件是某个已注册主插件的别名，且主插件已就绪，则忽略重复/次要注册，防止执行翻倍
    if (primaryId && this.plugins.has(primaryId)) {
      return;
    }

    // 2. 获取当前插件的所有别名（合并自带声明与已知内置别名）
    const aliases = [
      ...(plugin.aliases ?? []),
      ...(DEFAULT_BUILTIN_ALIASES[plugin.id] ?? []),
    ];

    // 清理先前以别名身份单独注册的次要实例，并更新别名索引
    if (aliases.length > 0) {
      for (const alias of aliases) {
        if (this.plugins.has(alias)) {
          this.plugins.delete(alias);
        }
        this.aliasMap.set(alias, plugin.id);
      }
    }

    this.plugins.set(plugin.id, plugin);
  }

  unregister(id: string): void {
    const primaryId = this.resolvePluginId(id);
    const plugin = this.plugins.get(primaryId);
    if (plugin?.aliases) {
      for (const alias of plugin.aliases) {
        this.aliasMap.delete(alias);
      }
    }
    this.plugins.delete(primaryId);
    this.aliasMap.delete(id);
  }

  /** 获取插件（支持主 ID 与别名寻址） */
  get(idOrAlias: string): ServerPlugin | undefined {
    const direct = this.plugins.get(idOrAlias);
    if (direct) return direct;
    const primaryId = this.aliasMap.get(idOrAlias);
    if (primaryId) return this.plugins.get(primaryId);
    return undefined;
  }

  /** 解析真实的主插件 ID（若为别名则返回其归属的主插件 ID） */
  resolvePluginId(idOrAlias: string): string {
    return this.aliasMap.get(idOrAlias) ?? idOrAlias;
  }

  /** 获取插件及其所有别名候选列表（优先返回主 ID） */
  getAllAliases(idOrAlias: string): string[] {
    const primaryId = this.resolvePluginId(idOrAlias);
    const plugin = this.plugins.get(primaryId);
    if (!plugin) return [idOrAlias];
    const aliases = plugin.aliases ?? [];
    return [primaryId, ...aliases.filter((a) => a !== primaryId)];
  }

  getAll(): ServerPlugin[] {
    return Array.from(this.plugins.values());
  }

  clear(): void {
    this.plugins.clear();
    this.aliasMap.clear();
  }
}

/** 保持向后兼容类与单例别名导出 */
export const ServerTurnPluginRegistry = ServerPluginRegistry;
export type ServerTurnPluginRegistry = ServerPluginRegistry;

export const defaultServerPluginRegistry = new ServerPluginRegistry();
export const defaultServerTurnPluginRegistry = defaultServerPluginRegistry;

