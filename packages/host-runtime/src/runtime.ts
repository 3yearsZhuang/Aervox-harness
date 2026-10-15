/**
 * Aervox｜思隅 @aervox/api — Fastify 应用工厂
 *
 * 允许注入内存/临时数据库用于集成测试；不负责 listen（由入口或测试调用方控制）。
 * 按 ADR-014 演进式模块化单体组织：注册领域模块，各自实例化仓储；模块间共享
 * 依赖（toolRuntime / llmConfigService / voiceService / skillManager）经
 * ModuleContext 提供，装配顺序（tools/llm 先于 conversation、persona 等）显式声明。
 */
import Fastify from "fastify";
import path from "node:path";
import cors from "@fastify/cors";
import { buildOpenApiDocument, getPluginApiRevision } from "@aervox/contracts";
import {
  createDatabase,
  createProactiveVaultDatabase,
  initDatabaseSchema,
  loadProactiveAccessToken,
  loadProactiveVaultCipher,
  type AervoxDatabase,
  type ProactiveVaultCipher,
  Cr030MigrationStateStore,
  assertSafeStartup,
} from "@aervox/repositories";
import type { Client } from "@libsql/client";
import type { WorkflowDefinition } from "@aervox/core";
// 业务模块（按 ADR-014 0.3.0 六域分组；CR-052）
// ── companion（陪伴与对话） ──
import { registerConversationModule, type ConversationHost } from "./modules/companion/conversation/index.js";
import { registerBranchModule } from "./modules/companion/branch/index.js";
import { registerMemoryModule } from "./modules/companion/memory/index.js";
import { registerInboxModule } from "./modules/companion/inbox/index.js";
import { registerPersonaModule } from "./modules/companion/persona/index.js";
// ── learning（学习与练习） ──
import { registerLearningModule } from "./modules/learning/learning/index.js";
import { registerStudyMaterialModule } from "./modules/learning/study-materials/index.js";
import { registerDiaryModule } from "./modules/learning/diary/index.js";
// ── knowledge（知识与内容） ──
import { registerKnowledgeModule } from "./modules/knowledge/knowledge/index.js";
import { registerContentModule } from "./modules/knowledge/content/index.js";
import { registerProjectModule } from "./modules/knowledge/project/index.js";
// ── ecosystem（扩展生态） ──
import { registerToolsModule } from "./modules/ecosystem/tools/index.js";
import { registerMcpModule, type McpModuleOptions } from "./modules/ecosystem/mcp/index.js";
import { registerPluginsModule, createServerPluginRegistry, type ServerPluginRegistry } from "./modules/ecosystem/plugins/index.js";
import { createPluginHostServicesFactory } from "./plugin-host-services.js";
import { registerSkillsModule } from "./modules/ecosystem/skills/index.js";
import { registerLLMModule, type LLMServiceOptions } from "./modules/ecosystem/llm/index.js";
import {
  registerModelRuntimeModule,
  type ModelRuntimeModuleOptions,
} from "./modules/ecosystem/model-runtime/index.js";
// ── proactive（主动智能） ──
import { registerProactiveModule } from "./modules/proactive/proactive/index.js";
import { registerNotificationModule } from "./modules/proactive/notification/index.js";
// ── platform（平台基础） ──
import { registerFeedbackModule } from "./modules/platform/feedback/index.js";
import { registerPrivacyModule } from "./modules/platform/privacy/index.js";
import { registerAnalyticsModule } from "./modules/platform/analytics/index.js";
import { registerPreferencesModule } from "./modules/platform/preferences/index.js";
import { registerVoiceModule, type VoiceModuleOptions } from "./modules/platform/voice/index.js";
import { registerSafetyModule } from "./modules/platform/safety/index.js";
import type { ToolRuntimePort as ToolRuntime } from "./modules/ecosystem/tools/index.js";
import type { MemoryEmbeddingProvider } from "./modules/companion/memory/index.js";
import { assertAuthConfigSafe, createAuthHook, loadAuthConfig, type AuthConfig } from "./shared/auth.js";
import { createToolApprovalPolicyHook } from "./shared/tool-approval-policy.js";
import { ApiError, type ApiErrorCode } from "./shared/errors.js";
import { registerProblemDetails } from "./shared/problem-details.js";
import { DatabaseError } from "@aervox/repositories";
import {
  createStandardLogger,
  createInMemoryMetricsRegistry,
  noopAudit,
  type Observability,
  type InMemoryMetricsRegistry,
} from "@aervox/observability";
import { loadApiConfig } from "@aervox/config";

export interface BuildAppOptions {
  /** Worker owns scheduling; its shared HTTP adapter remains unbound. */
  role?: "api" | "worker";
  /** 注入既有数据库（如内存库）；缺省时使用 createDatabase() */
  db?: AervoxDatabase;
  client?: Client;
  /** CAP-033：注入独立本地主动画像 Vault（生产建议显式传入） */
  proactiveDb?: AervoxDatabase;
  proactiveClient?: Client;
  proactiveCipher?: ProactiveVaultCipher;
  /** CAP-033 loopback device token；null 仅供显式测试禁用。 */
  proactiveAccessToken?: string | null;
  proactiveFeatureFlags?: ReadonlySet<import("@aervox/config").ProactiveFeatureFlag>;
  /** Skill 内容落盘根目录（测试注入临时目录；缺省 <repo>/data/skills） */
  skillsRoot?: string;
  /** 插件 Page Bundle 落盘根目录（测试注入临时目录；缺省 <repo>/data/plugins） */
  pluginsRoot?: string;
  builtinPluginsSourceRoot?: string;
  /** 服务端通用插件注册表（默认创建独立实例） */
  pluginRegistry?: ServerPluginRegistry;
  /** CR-060：插件宿主服务工厂（默认按 db 构造；测试可注入替身） */
  pluginHostServices?: import("./plugin-assembly.js").PluginHostServicesFactory;
  /** 附件二进制落盘根目录（测试注入临时目录；缺省 <repo>/data/attachments） */
  attachmentsRoot?: string;
  /** 语音服务配置（如测试注入 mock provider） */
  voiceOptions?: VoiceModuleOptions;
  /** MCP 预设模块配置（如测试注入 fake fetch） */
  mcpOptions?: McpModuleOptions;
  /** LLM 模型服务配置 */
  llmOptions?: LLMServiceOptions;
  /** 本地模型运行时配置（模型目录 / llama-server 探测注入等） */
  modelRuntimeOptions?: ModelRuntimeModuleOptions;
  /** 长期记忆向量 Provider；undefined 使用本地特征哈希，null 显式关闭向量通道。 */
  embeddingProvider?: MemoryEmbeddingProvider | null;
  /** 阶段 5c：已注册 Workflow 定义清单（贡献 workflow_run 工具 + GET /v1/workflows） */
  workflows?: WorkflowDefinition[];
  /** 认证配置（缺省从环境加载：AERVOX_AUTH_MODE / AERVOX_AUTH_TOKEN） */
  auth?: AuthConfig;
  /** CR-030 sidecar 状态清单路径（测试/维护编排可注入）。 */
  migrationStatePath?: string;
  /** 是否在启动时执行 initDatabaseSchema。缺省在注入外部 db/client 时为 false（避免重复执行已就绪的 Schema DDL），未注入时为 true。 */
  initSchema?: boolean;
  /** 可观测性门面（日志/指标/审计；缺省使用 createStandardLogger + createInMemoryMetricsRegistry） */
  observability?: Observability;
}

export interface BuildAppResult {
  conversation: ConversationHost;
  app: ReturnType<typeof Fastify>;
  /** Actual registered HTTP routes, including descriptor-driven and plugin routes. */
  readonly routeInventory: readonly { method: string; path: string }[];
  db: AervoxDatabase;
  client: Client;
  /** Agent Loop 只读工具提供者宿主（测试注入 handler 用；阶段 2d） */
  toolRuntime: ToolRuntime;
  /** 全链路可观测性门面 */
  observability: Observability;
  /** 内存指标注册表（便于测试断言或监控导出） */
  metricsRegistry?: InMemoryMetricsRegistry;
  /** CAP-033 主动画像 Vault 连接（与主业务库分离时返回独立连接） */
  proactiveDb?: AervoxDatabase;
  proactiveClient?: Client;
}

export async function buildHostRuntime(options: BuildAppOptions = {}): Promise<BuildAppResult> {
  const app = Fastify({ logger: false });
  const routeInventory: { method: string; path: string }[] = [];
  app.addHook("onRoute", (route) => {
    for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
      routeInventory.push({ method, path: route.url });
    }
  });
  registerProblemDetails(app);
  const apiConfig = loadApiConfig();
  const metricsRegistry =
    options.observability?.metrics && "toPrometheusText" in options.observability.metrics
      ? (options.observability.metrics as InMemoryMetricsRegistry)
      : createInMemoryMetricsRegistry();
  const observability: Observability =
    options.observability ?? {
      log: createStandardLogger({
        level: apiConfig.logLevel,
        format: apiConfig.logFormat,
      }),
      metrics: metricsRegistry,
      audit: noopAudit,
    };

  const migrationStatePath = options.migrationStatePath ?? process.env.AERVOX_CR030_STATE_PATH ??
    path.join(process.cwd(), "data", "aervox.cr030.migration.json");
  assertSafeStartup(await new Cr030MigrationStateStore(migrationStatePath).read());
  const injectedMainDatabase = Boolean(options.db && options.client);
  const { db, client } =
    injectedMainDatabase ? { db: options.db!, client: options.client! } : await createDatabase();
  const shouldInitSchema = options.initSchema ?? !injectedMainDatabase;
  if (shouldInitSchema) {
    await initDatabaseSchema(client);
  }

  // CAP-033：默认启动时使用独立本地 Vault；集成测试显式注入主库时复用该连接，
  // 避免每个测试创建用户目录文件。生产可通过 options 注入已初始化的加密 Vault。
  let proactiveDb = options.proactiveDb;
  let proactiveClient = options.proactiveClient;
  let proactiveCipher = options.proactiveCipher;
  let proactiveAccessToken = options.proactiveAccessToken;
  let ownsProactiveClient = false;
  if (!proactiveDb || !proactiveClient) {
    if (injectedMainDatabase) {
      proactiveDb = db;
      proactiveClient = client;
    } else {
      const vault = await createProactiveVaultDatabase();
      proactiveDb = vault.db;
      proactiveClient = vault.client;
      proactiveCipher ??= await loadProactiveVaultCipher();
      ownsProactiveClient = true;
      await initDatabaseSchema(proactiveClient);
    }
  } else if (shouldInitSchema) {
    await initDatabaseSchema(proactiveClient);
  }
  const testDatabaseFallback = injectedMainDatabase && !options.proactiveDb && !options.proactiveClient;
  if (proactiveAccessToken === undefined && !testDatabaseFallback) {
    proactiveAccessToken = await loadProactiveAccessToken();
  }

  // Map domain errors to HTTP; the onSend hook supplies the shared Problem Details envelope.
  // DatabaseError 携带领域语义（NOT_FOUND/FORBIDDEN/CONFLICT），在此映射为 HTTP 状态码，
  // 避免数据层裸 Error 被当作 500（资源访问拒绝应 403、资源缺失应 404、领域冲突应 409）。
  const dbCodeToApi: Record<DatabaseError["domainCode"], { code: ApiErrorCode; status: number }> = {
    NOT_FOUND: { code: "NOT_FOUND", status: 404 },
    FORBIDDEN: { code: "FORBIDDEN", status: 403 },
    CONFLICT: { code: "CONFLICT", status: 409 },
  };
  app.setErrorHandler((err: unknown, req, reply) => {
    const errorObj = err instanceof Error ? err : new Error(String(err));
    const errRecord = typeof err === "object" && err !== null ? (err as Record<string, unknown>) : {};
    const statusCode =
      typeof errRecord.statusCode === "number"
        ? errRecord.statusCode
        : reply.statusCode >= 400
          ? reply.statusCode
          : 500;
    observability.log.error({
      event: "http.request.error",
      message: `Error handling ${req.method} ${req.url}: ${errorObj.message}`,
      fields: {
        requestId: req.id,
        method: req.method,
        url: req.url,
        error: errorObj.name,
        code: typeof errRecord.code === "string" ? errRecord.code : undefined,
        statusCode,
        stack: errorObj.stack,
      },
    });
    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send({ error: err.name, code: err.code, message: err.message });
    }
    if (err instanceof DatabaseError) {
      const mapped = dbCodeToApi[err.domainCode] ?? { code: "INTERNAL_ERROR" as const, status: 500 };
      return reply.code(mapped.status).send({ error: err.name, code: mapped.code, message: err.message });
    }
    // Unexpected failures stay detailed in server logs, never in a client response.
    if (statusCode >= 500) {
      return reply.code(statusCode).send({ error: "Internal Server Error", code: "INTERNAL_ERROR", message: "Internal Server Error" });
    }
    // Fastify request/parser errors retain their established code and message.
    return reply.send(err as any);
  });

  // 全链路 HTTP 请求生命周期与耗时可观测性
  const requestStartTimes = new WeakMap<object, bigint>();
  app.addHook("onRequest", async (req) => {
    requestStartTimes.set(req, process.hrtime.bigint());
  });
  app.addHook("onResponse", async (req, reply) => {
    const startTime = requestStartTimes.get(req);
    const durationMs = startTime
      ? Number(process.hrtime.bigint() - startTime) / 1_000_000
      : 0;
    observability.log.info({
      event: "http.request.completed",
      message: `${req.method} ${req.url} ${reply.statusCode} (${durationMs.toFixed(2)}ms)`,
      fields: {
        requestId: req.id,
        method: req.method,
        url: req.url,
        statusCode: reply.statusCode,
        durationMs: Number(durationMs.toFixed(2)),
      },
    });
  });

  // 认证前置关口：open=本地免认证；token=强制 Bearer token（生产环境强制守卫校验）
  const authConfig = options.auth ?? loadAuthConfig();
  assertAuthConfigSafe(authConfig);
  app.addHook("onRequest", createAuthHook(authConfig));
  if (process.env.AERVOX_NATIVE_SUPERVISOR_MANAGED === "1") {
    app.get("/v1/native-ready", async () => ({ status: "ready", role: "api", protocol: 1 }));
  }
  app.addHook("preValidation", createToolApprovalPolicyHook());

  // CORS：允许本地 Web/移动端跨源访问（生产环境按部署配置收紧 origin）
  await app.register(cors, {
    origin: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });

  // The document follows the current contribution revision, including removal/reload.
  // CR-060：插件端点在宿主装配阶段登记，故文档必须晚于插件加载生成，不能在此处预序列化。
  let openApiSerialized: string | null = null;
  let openApiRevision = -1;
  app.get("/openapi.json", async (_req, reply) => {
    const revision = getPluginApiRevision();
    if (openApiSerialized === null || revision !== openApiRevision) {
      openApiSerialized = JSON.stringify(buildOpenApiDocument());
      openApiRevision = revision;
    }
    reply.header("Content-Type", "application/json; charset=utf-8");
    reply.header("Cache-Control", "private, no-store");
    return openApiSerialized;
  });

  // 指标端点：暴露 Prometheus 格式或 JSON 快照（受全局认证保护）
  app.get("/v1/metrics", async (req, reply) => {
    const acceptHeader = req.headers.accept ?? "";
    const queryFormat = (req.query as { format?: string }).format;
    const format = queryFormat ?? (acceptHeader.includes("application/json") ? "json" : "prometheus");
    if (format === "json") {
      reply.header("Content-Type", "application/json; charset=utf-8");
      if (metricsRegistry) {
        return metricsRegistry.getSnapshot();
      }
      return { message: "Metrics registry unavailable" };
    }
    reply.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    return metricsRegistry ? metricsRegistry.toPrometheusText() : "";
  });

// 模块装配上下文：基础设施 + 构建期配置；共享服务按注册顺序填充
  const ctx = {
    app,
    db,
    client,
    observability,
    proactiveDb,
    proactiveClient,
    proactiveCipher,
    proactiveAccessToken,
    workflows: options.workflows,
    skillsRoot: options.skillsRoot,
    pluginsRoot: options.pluginsRoot,
    builtinPluginsSourceRoot: options.builtinPluginsSourceRoot,
    attachmentsRoot: options.attachmentsRoot,
    pluginRegistry: options.pluginRegistry ?? createServerPluginRegistry(),
    // CR-060：插件宿主服务工厂只依赖 db，构建期即确定，供插件端点与回合工具贡献共用
    pluginHostServices: options.pluginHostServices ?? createPluginHostServicesFactory(db),
  };

  // 组合根显式构造依赖；模块只能接收其声明的只读输入。
  // tools → llm 必须早于 conversation（Agent Loop 依赖）；voice/skills 早于 persona。
  // 注册顺序保持既有依赖序（Fastify hook/路由顺序敏感，不做域重排）；
  // 域归属见 import 分组（CR-052 / ADR-014 0.3.0）。
  const toolRuntime = registerToolsModule(ctx);
  const withTools = { ...ctx, toolRuntime };
  const memoryRecall = await registerMemoryModule(withTools, { embeddingProvider: options.embeddingProvider });
  const mcp = registerMcpModule(withTools, options.mcpOptions);
  const llm = registerLLMModule(withTools, options.llmOptions);
  const withModel = { ...withTools, memoryRecall, llmConfigService: llm.config, modelRoutingService: llm.routing };
  const modelRuntimeService = registerModelRuntimeModule(withModel, options.modelRuntimeOptions);
  const safetyService = registerSafetyModule(withModel);
  const proactive = await registerProactiveModule(withModel, {
    startBackground: options.role !== "worker",
    db: proactiveDb,
    cipher: proactiveCipher,
    accessToken: proactiveAccessToken,
    featureFlags: options.proactiveFeatureFlags ?? apiConfig.proactiveFeatureFlags,
  });
  let personaService: ReturnType<typeof registerPersonaModule> | undefined;
  let pluginRegistrations: Awaited<ReturnType<typeof registerPluginsModule>> | undefined;
  const services = {
    ...withModel, modelRuntimeService, safetyService,
    proactiveRepository: proactive.repository,
    proactiveIntelligenceRepository: proactive.intelligenceRepository,
    proactiveActionAuthorizer: proactive.actionAuthorizer,
    getPersona: () => personaService,
    getPluginRegistrations: () => pluginRegistrations,
  };
  // 保留路由与 Hook 的注册顺序；晚装配服务通过显式查询端口提供。
  const conversation = registerConversationModule(services, {
    startupRecovery: options.role !== "worker",
    prepareExecution: () => mcp.restoreOnStartup(),
    isMcpToolAllowed: tool => mcp.allowsTool(tool),
  });
  registerLearningModule(services);
  registerFeedbackModule(services);
  await registerDiaryModule(services);
  registerContentModule(services);
  registerNotificationModule(services);
  registerPrivacyModule(services);
  registerAnalyticsModule(services);
  registerKnowledgeModule(services);
  registerBranchModule(services);
  registerProjectModule(services);
  pluginRegistrations = await registerPluginsModule(services);
  const voiceService = registerVoiceModule(services, options.voiceOptions);
  const skillManager = await registerSkillsModule(services);
  registerPreferencesModule(services);
  registerStudyMaterialModule(services);
  personaService = registerPersonaModule({ ...services, voiceService, skillManager });
  registerInboxModule(services);

  if (ownsProactiveClient) {
    app.addHook("onClose", async () => {
      proactiveClient?.close();
    });
  }

  return {
    conversation,
    app,
    get routeInventory() { return routeInventory.map((route) => ({ ...route })); },
    db,
    client,
    toolRuntime,
    observability,
    metricsRegistry,
    proactiveDb,
    proactiveClient,
  };
}
