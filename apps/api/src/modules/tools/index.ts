/**
 * Aervox｜思隅 @aervox/api — 工具系统模块入口（T-04 / AST-04 / PET-05）
 *
 * 实例化 ToolRuntime 并在启动时把内置工具（aervox_memory_store）幂等同步进
 * tool_registrations，保证「注册表」与「运行时 handler」两处事实一致。
 */
import type { ModuleContext } from "../context.js";
import {
  SqliteMemoryRepository,
  SqliteMemoryEmbeddingRepository,
  SqliteToolRegistryRepository,
} from "@aervox/database";
import { registerToolRoutes } from "./routes.js";
import { ToolRuntime } from "./runtime.js";
import type { MemoryEmbeddingProvider } from "./embedding-provider.js";

export interface RegisterToolsModuleOptions {
  /** 生产环境注入真实 embedding 服务；未注入时记忆工具向量降级 skipped */
  embeddingProvider?: MemoryEmbeddingProvider | null;
}

export function registerToolsModule(
  ctx: ModuleContext,
  options: RegisterToolsModuleOptions = {},
): ToolRuntime {
  const { app, db, client } = ctx;
  const registry = new SqliteToolRegistryRepository(db);
  const memoryRepo = new SqliteMemoryRepository(db, client);
  const embeddingRepo = new SqliteMemoryEmbeddingRepository(db);

  const runtime = new ToolRuntime({
    registry,
    memoryRepo,
    embeddingRepo,
    client,
    embeddingProvider: options.embeddingProvider ?? null,
  });

  // 同步登记内置工具（幂等；enabled 保持既有开关）
  void registry.registerTool({
    id: "aervox_memory_store",
    name: "aervox_memory_store",
    description:
      "主动存储长期记忆：AI 在对话中把值得长期记住的内容（身份/偏好/习惯/日程/事件）显式写入记忆库；user_said 直接置信，ai_inferred 默认进入候选待用户确认。",
    category: "memory",
    safetyLevel: "write_with_approval",
    requiredPermissions: [],
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "记忆内容（自然语言）" },
        source: { type: "string", enum: ["user_said", "ai_inferred"] },
        category: {
          type: "string",
          enum: ["identity", "preference", "habit", "schedule", "relationship", "event", "other"],
        },
        keywords: { type: "array", items: { type: "string" } },
        sourceTurnId: { type: "string" },
        asCandidate: { type: "boolean" },
      },
      required: ["content"],
    },
    builtin: true,
    gatingConditions: [],
    priority: 100,
  });

  registerToolRoutes(app, runtime);
  return runtime;
}