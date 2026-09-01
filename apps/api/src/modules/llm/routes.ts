import type { FastifyInstance } from "fastify";
import {
  llmConfigSchema,
  llmCreatePresetRequestSchema,
  llmTestConnectionRequestSchema,
} from "@aervox/contracts";
import { resolveTenant } from "../../shared/tenant.js";
import type { LLMConfigService } from "./service.js";

export function registerLLMRoutes(app: FastifyInstance, service: LLMConfigService): void {
  // GET /v1/llm/config — 读取大语言模型配置（当前激活预设）
  app.get("/v1/llm/config", async (req) => {
    const tenant = resolveTenant(req);
    return service.getConfig(tenant);
  });

  // PUT /v1/llm/config — 保存大语言模型配置（写入当前激活预设）
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

  // ---- 多预设管理（与人格设定同款：列表/新建/激活/删除） ----

  // GET /v1/llm/presets — 列出全部预设（含激活标记）
  app.get("/v1/llm/presets", async (req) => {
    const tenant = resolveTenant(req);
    return service.listPresets(tenant);
  });

  // POST /v1/llm/presets — 新建预设
  app.post("/v1/llm/presets", async (req, reply) => {
    const tenant = resolveTenant(req);
    const parsed = llmCreatePresetRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        code: "INVALID_LLM_PRESET",
        message: "Invalid LLM preset payload",
        details: parsed.error.issues,
      });
    }
    try {
      const created = await service.createPreset(tenant, parsed.data.name, parsed.data.config);
      return reply.code(201).send(created);
    } catch (err) {
      return reply.code(400).send({
        code: "INVALID_LLM_PRESET",
        message: err instanceof Error ? err.message : "Failed to create LLM preset",
      });
    }
  });

  // POST /v1/llm/presets/:presetId/activate — 激活指定预设
  app.post("/v1/llm/presets/:presetId/activate", async (req, reply) => {
    const { presetId } = req.params as { presetId: string };
    const tenant = resolveTenant(req);
    const activated = await service.activatePreset(tenant, presetId);
    if (!activated) {
      return reply.code(404).send({ code: "PRESET_NOT_FOUND", message: "LLM preset not found" });
    }
    return activated;
  });

  // DELETE /v1/llm/presets/:presetId — 删除指定预设
  app.delete("/v1/llm/presets/:presetId", async (req, reply) => {
    const { presetId } = req.params as { presetId: string };
    const tenant = resolveTenant(req);
    const deleted = await service.deletePreset(tenant, presetId);
    if (!deleted) {
      return reply.code(404).send({ code: "PRESET_NOT_FOUND", message: "LLM preset not found" });
    }
    return { deleted: true, presetId };
  });
}