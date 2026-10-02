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
 *
 * 本文件同时承担**契约到框架**的适配：把 `@aervox/host-plugin-api` 的
 * `PluginHttpEndpoint` 挂载为真实 Fastify 路由（鉴权、本地上下文解析与出参包装由宿主负责）。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  PluginHostServices,
  ServerPluginRegistration,
  TurnPluginRegistryPort,
} from "@aervox/host-plugin-api";
import type { LocalContext } from "@aervox/repositories";
import { resolveLocalContext } from "./shared/local-context.js";

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
  /** HTTP 端点接收器（宿主适配为真实路由） */
  onHttpEndpoints?: (pluginId: string, endpoints: ServerPluginRegistration["httpEndpoints"]) => void;
  /** 诊断输出；缺省静默，便于测试 */
  warn?: (message: string, error?: unknown) => void;
}

export interface PluginAssemblyResult {
  loaded: string[];
  failed: string[];
  /** 成功加载的注册单元：宿主据此在回合内按需请求工具贡献（按上下文构造） */
  registrations: ServerPluginRegistration[];
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
  const registrations: ServerPluginRegistration[] = [];

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
      if (registration.httpEndpoints?.length) {
        targets.onHttpEndpoints?.(registration.pluginId, registration.httpEndpoints);
      }
      registrations.push(registration);
      loaded.push(registration.pluginId);
    } catch (error) {
      failed.push(registration.pluginId);
      targets.warn?.(`[plugin-assembly] 插件 ${registration.pluginId} 贡献装配失败`, error);
    }
  }

  return { loaded, failed, registrations };
}

/** 宿主按本地上下文产出插件服务集合的工厂（组合根注入，见 plugin-host-services.ts） */
export type PluginHostServicesFactory = (ctx: LocalContext) => PluginHostServices;

/**
 * 插件启用判定：宿主按仓储启停与可用性记录判定（与回合切面、工具贡献同一判据）。
 * 缺省视为不启用（fail-closed）：未经显式判定的调用方不得让插件 API 面生效。
 */
export type PluginEnablementPredicate = (pluginId: string) => Promise<boolean>;

/**
 * 把插件声明的 HTTP 端点挂载为 Fastify 路由。
 *
 * 契约要求插件不依赖具体 Web 框架：方法、路径与业务处理归插件，鉴权、限流、
 * 本地上下文解析、出参包装与异常兜底一律由宿主在此收口。
 *
 * 插件 API 面随插件**生效状态**（启用且可用）门控：停用或缺包的插件端点一律 404，
 * 与面向模型的贡献同一判据；判定在**每请求**执行，故运行期启停无需重启宿主。
 */
export function mountPluginHttpEndpoints(
  app: FastifyInstance,
  pluginId: string,
  endpoints: ServerPluginRegistration["httpEndpoints"],
  services: PluginHostServicesFactory,
  warn?: (message: string, error?: unknown) => void,
  isEnabled?: PluginEnablementPredicate,
): void {
  for (const endpoint of endpoints ?? []) {
    const handler = async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        if (isEnabled && !(await isEnabled(pluginId))) {
          return reply.status(404).send({ error: "Plugin endpoint unavailable" });
        }
        const result = await endpoint.handler(
          {
            params: (request.params ?? {}) as Record<string, string>,
            query: (request.query ?? {}) as Record<string, string>,
            body: request.body,
          },
          services(resolveLocalContext(request)),
        );
        return reply.status(result.status ?? 200).send(result.payload);
      } catch (error) {
        warn?.(`[plugin-assembly] 插件 ${pluginId} 端点 ${endpoint.path} 处理失败`, error);
        return reply.status(500).send({ error: "Plugin endpoint failed" });
      }
    };

    switch (endpoint.method) {
      case "GET":
        app.get(endpoint.path, handler);
        break;
      case "POST":
        app.post(endpoint.path, handler);
        break;
      case "PUT":
        app.put(endpoint.path, handler);
        break;
      case "PATCH":
        app.patch(endpoint.path, handler);
        break;
      case "DELETE":
        app.delete(endpoint.path, handler);
        break;
    }
  }
}

/** 便捷装配：直接接管端点挂载（组合根唯一调用点） */
export function createHttpEndpointSink(
  app: FastifyInstance,
  services: PluginHostServicesFactory,
  warn?: (message: string, error?: unknown) => void,
  isEnabled?: PluginEnablementPredicate,
): (pluginId: string, endpoints: ServerPluginRegistration["httpEndpoints"]) => void {
  return (pluginId, endpoints) =>
    mountPluginHttpEndpoints(app, pluginId, endpoints, services, warn, isEnabled);
}
