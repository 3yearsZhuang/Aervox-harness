/**
 * Aervox｜思隅 @aervox/api — Persona 领域模块（CAP-019/CAP-020）
 *
 * 持久化真源由 @aervox/database 的 SQLite 仓储承担；@aervox/mod-persona 提供
 * 纯领域逻辑（Skills ZIP 校验、Persona Bundle、Prompt 组合、MCP 策略、GPT-SoVITS Port）。
 * 路由层通过适配器把 SQLite 仓储接到模块 Port，领域编排保留在模块内。
 */
import type { FastifyInstance } from "fastify";
import type { AervoxDatabase } from "@aervox/database";
import {
  SqliteMcpToolRepository,
  SqlitePersonaRepository,
  SqliteSkillRepository,
} from "@aervox/database";
import type { VoiceProviderPort } from "@aervox/mod-persona";
import { GptSovitsLocalProvider, GptSovitsRemoteProvider } from "@aervox/mod-persona";
import {
  SqliteMcpToolRepositoryAdapter,
  SqlitePersonaRepositoryAdapter,
  SqliteSkillRepositoryAdapter,
} from "./adapters.js";
import { registerPersonaRoutes } from "./routes.js";

export interface PersonaModuleOptions {
  voiceProviders?: VoiceProviderPort[];
}

/** 未显式注入 Provider 时，按环境变量构造本地/远程 GPT-SoVITS 适配器 */
export function createDefaultVoiceProviders(): VoiceProviderPort[] {
  return [
    new GptSovitsLocalProvider("gpt-sovits-local", {
      modelId: "default-local",
      modelPath: process.env.GPT_SOVITS_MODEL_PATH,
      allowedRoots: process.env.GPT_SOVITS_ALLOWED_ROOTS?.split(":").filter(Boolean) ?? [],
    }),
    new GptSovitsRemoteProvider("gpt-sovits-remote", {
      endpoint: process.env.GPT_SOVITS_ENDPOINT,
      protocol: (process.env.GPT_SOVITS_PROTOCOL as "http" | "websocket" | undefined) ?? "http",
      modelId: process.env.GPT_SOVITS_MODEL_ID ?? "default-remote",
      secretRef: process.env.GPT_SOVITS_SECRET_REF,
    }),
  ];
}

export function registerPersonaModule(
  app: FastifyInstance,
  db: AervoxDatabase,
  options: PersonaModuleOptions = {},
): void {
  const personas = new SqlitePersonaRepositoryAdapter(new SqlitePersonaRepository(db));
  const skills = new SqliteSkillRepositoryAdapter(new SqliteSkillRepository(db));
  const mcp = new SqliteMcpToolRepositoryAdapter(new SqliteMcpToolRepository(db));
  const voiceProviders = new Map<string, VoiceProviderPort>(
    (options.voiceProviders ?? createDefaultVoiceProviders()).map((provider) => [provider.id, provider]),
  );
  registerPersonaRoutes(app, { personas, skills, mcp, voiceProviders });
}
