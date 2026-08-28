import type { FastifyInstance } from "fastify";
import {
  llmConfigSchema,
  llmTestConnectionRequestSchema,
} from "@aervox/contracts";
import { resolveTenant } from "../../shared/tenant.js";
import type { LLMConfigService } from "./service.js";

export function registerLLMRoutes(app: FastifyInstance, service: LLMConfigService): void {
  // GET /v1/llm/config — 读取大语言模型配置
  app.get("/v1/llm/config", async (req) => {
    const tenant = resolveTenant(req);
    return service.getConfig(tenant);
  });

  // PUT /v1/llm/config — 保存大语言模型配置
  app.put("/v1/llm/config", async (req, reply) => {
    const tenant = resolveTenant(req);
    const parsed = llmConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        code: "INVALID_LLM_CONFIG",
        message: "Invalid LLM config payload",
        details: parsed.error.issues,
      });
    }

    try {
      const saved = await service.saveConfig(tenant, parsed.data);
      return saved;
    } catch (err) {
      return reply.code(400).send({
        code: "INVALID_LLM_CONFIG",
        message: err instanceof Error ? err.message : "Failed to save LLM config",
      });
    }
  });

  // POST /v1/llm/test-connection — 连通性测试
  app.post("/v1/llm/test-connection", async (req, reply) => {
    const parsed = llmTestConnectionRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        code: "INVALID_REQUEST",
        message: "Invalid test connection request",
        details: parsed.error.issues,
      });
    }

    const result = await service.testConnection(parsed.data);
    return result;
  });
}
