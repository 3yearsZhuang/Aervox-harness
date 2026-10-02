/**
 * Aervox｜思隅 @aervox/api — 第一方插件装配点（CR-060）
 *
 * **本文件是宿主中唯一允许按 id 引用具体插件的位置**（AVX-PLUG-001 §4.1：
 * Hook 必须由组合根 import 并注册）。宿主其余部分不得出现插件领域标识，
 * 由 `scripts/check-host-domain-purity.mjs` 机器强制。
 *
 * 装配语义（对齐 CR-056「代码缺席与显式卸载分开」）：
 * - 插件模块缺失或加载失败时**不中断宿主启动**，只记录诊断并跳过其贡献；
 * - 插件是否真正生效仍由 Runner 按仓储中的启停与可用性记录门控，缺包不等于卸载，
 *   安装记录、配置、授权与数据管理入口一律保留。
 */
import type {
  PluginHttpEndpoint,
  PluginToolContribution,
  ServerPluginRegistration,
  TurnPluginRegistryPort,
} from "@aervox/host-plugin-api";

/**
 * 插件服务端模块形状。
 * 契约要求**默认导出**注册单元——宿主不识别任何具名导出，避免装配点绑定插件私有命名。
 */
export interface PluginServerModule {
  default?: ServerPluginRegistration;
}

interface PluginLoader {
  pluginId: string;
  load: () => Promise<PluginServerModule>;
}

/**
 * 第一方插件加载清单。
 * 每个条目单行书写：可移除性演练按行剥离条目以验证"删除实现后宿主仍可构建运行"。
 */
const FIRST_PARTY_PLUGIN_LOADERS: PluginLoader[] = [
  { pluginId: "focus-mode", load: () => import("@aervox/plugin-focus-mode/server") },
];

export interface PluginAssemblyTargets {
  /** 回合插件注册表；装配点按插件启用状态无关地注册，门控由 Runner 负责 */
  turnRegistry: TurnPluginRegistryPort;
  /** 工具贡献接收器（宿主决定如何合入模型工具面与提示词指南） */
  onToolContribution?: (pluginId: string, contribution: PluginToolContribution) => void;
  /** HTTP 端点接收器（宿主适配为真实路由） */
  onHttpEndpoints?: (pluginId: string, endpoints: PluginHttpEndpoint[]) => void;
  /** 诊断输出；缺省静默，便于测试 */
  warn?: (message: string, error?: unknown) => void;
}

export interface PluginAssemblyResult {
  loaded: string[];
  failed: string[];
}

/**
 * 装配全部第一方插件贡献。
 * 单个插件失败不影响其他插件与宿主启动。
 */
export async function assembleFirstPartyPlugins(
  targets: PluginAssemblyTargets,
  loaders: PluginLoader[] = FIRST_PARTY_PLUGIN_LOADERS,
): Promise<PluginAssemblyResult> {
  const loaded: string[] = [];
  const failed: string[] = [];

  for (const loader of loaders) {
    let registration: ServerPluginRegistration | undefined;
    try {
      const module = await loader.load();
      registration = module.default;
      if (!registration) {
        throw new Error("插件模块未默认导出 ServerPluginRegistration");
      }
    } catch (error) {
      failed.push(loader.pluginId);
      targets.warn?.(
        `[plugin-assembly] 插件 ${loader.pluginId} 未能加载；保留其安装记录、配置与数据管理入口，跳过本次贡献装配`,
        error,
      );
      continue;
    }

    try {
      for (const plugin of registration.turnPlugins ?? []) {
        targets.turnRegistry.register(plugin);
      }
      for (const contribution of registration.toolContributions ?? []) {
        targets.onToolContribution?.(registration.pluginId, contribution);
      }
      if (registration.httpEndpoints?.length) {
        targets.onHttpEndpoints?.(registration.pluginId, registration.httpEndpoints);
      }
      loaded.push(registration.pluginId);
    } catch (error) {
      failed.push(registration.pluginId);
      targets.warn?.(`[plugin-assembly] 插件 ${registration.pluginId} 贡献装配失败`, error);
    }
  }

  return { loaded, failed };
}
