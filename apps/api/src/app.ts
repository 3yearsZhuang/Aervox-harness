/**
 * Aervox｜思隅 @aervox/api — Fastify 应用工厂
 *
 * 允许注入内存/临时数据库用于集成测试；不负责 listen（由入口或测试调用方控制）。
 * 按 ADR-014 演进式模块化单体组织：注册领域模块，各自实例化仓储；模块间共享
 * 依赖（toolRuntime / llmConfigService / voiceService / skillManager）经
 * ModuleContext 提供，装配顺序（tools/llm 先于 conversation、persona 等）显式声明。
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import { openApiDocument } from "@aervox/contracts";
import {
  createDatabase,
  createProactiveVaultDatabase,
  initDatabaseSchema,
  loadProactiveAccessToken,
  loadProactiveVaultCipher,
  type AervoxDatabase,
  type ProactiveVaultCipher,
} from "@aervox/database";
import type { Client } from "@libsql/client";
import type { WorkflowDefinition } from "@aervox/agent-loop";
import { registerConversationModule } from "./modules/conversation/index.js";
import { registerLearningModule } from "./modules/learning/index.js";
import { registerFeedbackModule } from "./modules/feedback/index.js";
import { registerDiaryModule } from "./modules/diary/index.js";
import { registerContentModule } from "./modules/content/index.js";
import { registerNotificationModule } from "./modules/notification/index.js";
import { registerPrivacyModule } from "./modules/privacy/index.js";
import { registerAnalyticsModule } from "./modules/analytics/index.js";
import { registerMemoryModule } from "./modules/memory/index.js";
import { registerKnowledgeModule } from "./modules/knowledge/index.js";
import { registerBranchModule } from "./modules/branch/index.js";
import { registerToolsModule } from "./modules/tools/index.js";
import { registerPluginsModule } from "./modules/plugins/index.js";
import { registerPersonaModule } from "./modules/persona/index.js";
import { registerPreferencesModule } from "./modules/preferences/index.js";
import { registerSkillsModule } from "./modules/skills/index.js";
import { registerInboxModule } from "./modules/inbox/index.js";
import { registerTermsModule } from "./modules/terms/index.js";
import { registerStudyMaterialModule } from "./modules/study-materials/index.js";
import { registerVoiceModule, type VoiceModuleOptions } from "./modules/voice/index.js";
import { registerLLMModule, type LLMServiceOptions } from "./modules/llm/index.js";
import { registerProactiveModule } from "./modules/proactive/index.js";
import type { ModuleContext } from "./modules/context.js";
import type { ToolRuntime } from "./modules/tools/runtime.js";
import { createAuthHook, type AuthConfig } from "./shared/auth.js";
import { createToolApprovalPolicyHook } from "./shared/tool-approval-policy.js";
import { ApiError, type ApiErrorCode } from "./shared/errors.js";
import { DatabaseError } from "@aervox/database";

export interface BuildAppOptions {
  /** 注入既有数据库（如内存库）；缺省时使用 createDatabase() */
  db?: AervoxDatabase;
  client?: Client;
  /** CAP-033：注入独立本地主动画像 Vault（生产建议显式传入） */
  proactiveDb?: AervoxDatabase;
  proactiveClient?: Client;
  proactiveCipher?: ProactiveVaultCipher;
  /** CAP-033 loopback device token；null 仅供显式测试禁用。 */
  proactiveAccessToken?: string | null;
  /** Skill 内容落盘根目录（测试注入临时目录；缺省 <repo>/data/skills） */
  skillsRoot?: string;
  /** 插件 Page Bundle 落盘根目录（测试注入临时目录；缺省 <repo>/data/plugins） */
  pluginsRoot?: string;
  /** 语音服务配置（如测试注入 mock provider） */
  voiceOptions?: VoiceModuleOptions;
  /** LLM 模型服务配置 */
  llmOptions?: LLMServiceOptions;
  /** 阶段 5c：已注册 Workflow 定义清单（贡献 workflow.run 工具 + GET /v1/workflows） */
  workflows?: WorkflowDefinition[];
  /** 认证配置（缺省从环境加载：AERVOX_AUTH_MODE / AERVOX_AUTH_TOKEN） */
  auth?: AuthConfig;
}

export interface BuildAppResult {
  app: ReturnType<typeof Fastify>;
  db: AervoxDatabase;
  client: Client;
  /** Agent Loop 只读工具提供者宿主（测试注入 handler 用；阶段 2d） */
  toolRuntime: ToolRuntime;
  /** CAP-033 主动画像 Vault 连接（与主业务库分离时返回独立连接） */
  proactiveDb?: AervoxDatabase;
  proactiveClient?: Client;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<BuildAppResult> {
  const app = Fastify({ logger: false });
  const { db, client } =
    options.db && options.client ? { db: options.db, client: options.client } : await createDatabase();
  await initDatabaseSchema(client);

  // CAP-033：默认启动时使用独立本地 Vault；集成测试显式注入主库时复用该连接，
  // 避免每个测试创建用户目录文件。生产可通过 options 注入已初始化的加密 Vault。
  const injectedMainDatabase = Boolean(options.db && options.client);
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
  } else {
    await initDatabaseSchema(proactiveClient);
  }
  const testDatabaseFallback = injectedMainDatabase && !options.proactiveDb && !options.proactiveClient;
  if (proactiveAccessToken === undefined && !testDatabaseFallback) {
    proactiveAccessToken = await loadProactiveAccessToken();
  }

  // 统一错误序列化（缺陷6/B）：ApiError/DatabaseError → { error, code, message }；其余保持 Fastify 默认
  // DatabaseError 携带领域语义（NOT_FOUND/FORBIDDEN/CONFLICT），在此映射为 HTTP 状态码，
  // 避免数据层裸 Error 被当作 500（跨租户越权应 403、租户内缺失应 404、领域冲突应 409）。
  const dbCodeToApi: Record<DatabaseError["domainCode"], { code: ApiErrorCode; status: number }> = {
    NOT_FOUND: { code: "NOT_FOUND", status: 404 },
    FORBIDDEN: { code: "FORBIDDEN", status: 403 },
    CONFLICT: { code: "CONFLICT", status: 409 },
  };
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send({ error: err.name, code: err.code, message: err.message });
    }
    if (err instanceof DatabaseError) {
      const mapped = dbCodeToApi[err.domainCode] ?? { code: "INTERNAL_ERROR" as const, status: 500 };
      return reply.code(mapped.status).send({ error: err.name, code: mapped.code, message: err.message });
    }
    // 非业务异常（schema validation / 5xx）：走 Fastify 默认序列化与状态码
    return reply.send(err);
  });

  // 认证前置关口：open=本地免认证；token=强制 Bearer token（校验通过才进入路由与仓储）
  app.addHook("onRequest", createAuthHook(options.auth));
  app.addHook("preValidation", createToolApprovalPolicyHook());

  // CORS：允许本地 Web/移动端跨源访问（生产环境按部署配置收紧 origin）
  await app.register(cors, {
    origin: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });

  // 契约骨架：暴露由 @aervox/contracts 生成的 OpenAPI 3.1 文档
  app.get("/openapi.json", async () => openApiDocument);

// 模块装配上下文：基础设施 + 构建期配置；共享服务按注册顺序填充
  const ctx: ModuleContext = {
    app,
    db,
    client,
    proactiveDb,
    proactiveClient,
    proactiveCipher,
    proactiveAccessToken,
    workflows: options.workflows,
    skillsRoot: options.skillsRoot,
    pluginsRoot: options.pluginsRoot,
  };

  // 先注册「被依赖」模块并填充共享服务（依赖方经 ctx 读取；顺序显式）：
  // tools → llm 必须早于 conversation（Agent Loop 依赖）；voice/skills 早于 persona
  ctx.toolRuntime = registerToolsModule(ctx);
  ctx.llmConfigService = registerLLMModule(ctx, options.llmOptions);
  registerProactiveModule(ctx, {
    db: proactiveDb,
    cipher: proactiveCipher,
    accessToken: proactiveAccessToken,
  });
  registerConversationModule(ctx);
  registerLearningModule(ctx);
  registerFeedbackModule(ctx);
  registerDiaryModule(ctx);
  registerContentModule(ctx);
  registerNotificationModule(ctx);
  registerPrivacyModule(ctx);
  registerAnalyticsModule(ctx);
  registerMemoryModule(ctx);
  registerKnowledgeModule(ctx);
  registerBranchModule(ctx);
  await registerPluginsModule(ctx);
  ctx.voiceService = registerVoiceModule(ctx, options.voiceOptions);
  ctx.skillManager = registerSkillsModule(ctx);
  registerPreferencesModule(ctx);
  registerStudyMaterialModule(ctx);
  registerPersonaModule(ctx);
  registerInboxModule(ctx);
  registerTermsModule(ctx);

  if (ownsProactiveClient) {
    app.addHook("onClose", async () => {
      proactiveClient?.close();
    });
  }

  return { app, db, client, toolRuntime: ctx.toolRuntime!, proactiveDb, proactiveClient };
}
