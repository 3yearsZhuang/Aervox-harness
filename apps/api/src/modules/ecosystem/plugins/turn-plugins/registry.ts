/**
 * Aervox｜思隅 @aervox/api — 服务端插件注册表 (Server Plugin Registry)
 *
 * 统一管理服务端插件生命周期与回合切面。
 *
 * CR-060：**不保留别名体系**。历史旧 id 别名与通用别名映射（`aliasMap` /
 * `registerAliases` / 构造期 `initialAliases`）一并删除——别名没有生产声明方，
 * 保留即等于给"同一插件按多个 id 生效"留后门（注册翻倍与门控判据分叉）。
 * 插件 id 唯一且与 Manifest `metadata.id` 一致。
 *
 * `resolvePluginId` / `getAllAliases` 保留为**单 id** 语义占位：调用方（配置与卸载
 * 路径）据此按 id 收敛即可，无需感知别名。
 */
import type { ServerPlugin, ServerTurnPlugin } from "./types.js";

export class ServerPluginRegistry {
  private readonly plugins = new Map<string, ServerPlugin>();

  register(plugin: ServerPlugin): () => void {
    if (this.plugins.has(plugin.id)) this.unregister(plugin.id);
    this.plugins.set(plugin.id, plugin);
    return () => {
      if (this.plugins.get(plugin.id) === plugin) this.unregister(plugin.id);
    };
  }

  unregister(id: string): void {
    this.plugins.delete(id);
  }

  /** 按插件 id 获取（无别名寻址） */
  get(id: string): ServerPlugin | undefined {
    return this.plugins.get(id);
  }

  /** 解析插件主 id；无别名体系，原样返回 */
  resolvePluginId(id: string): string {
    return id;
  }

  /** 该 id 对应的候选 id 列表；无别名体系，故仅含自身 */
  getAllAliases(id: string): string[] {
    return [id];
  }

  getAll(): ServerPlugin[] {
    return Array.from(this.plugins.values());
  }

  clear(): void {
    this.plugins.clear();
  }
}

/** 保持向后兼容类与单例别名导出 */
export const ServerTurnPluginRegistry = ServerPluginRegistry;
export type ServerTurnPluginRegistry = ServerPluginRegistry;

export const defaultServerPluginRegistry = new ServerPluginRegistry();
export const defaultServerTurnPluginRegistry = defaultServerPluginRegistry;
