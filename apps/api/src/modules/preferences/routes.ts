/**
 * Aervox｜思隅 @aervox/api — 偏好路由（CAP-010 人格问卷与基础偏好）
 *
 * 覆盖：FR-PER-001（问卷/跳过）、FR-PER-002（修改/重置）、BR-PER-001（中性默认值）、BR-PER-002（安全覆盖）
 */
import type { FastifyInstance } from "fastify";
import type { IPersonaPreferencesRepository } from "@aervox/database";
import {
  savePersonaPreferencesSchema,
  updatePersonaPreferencesSchema,
} from "@aervox/contracts";
import { resolveTenant } from "../../shared/tenant.js";

export function registerPreferencesRoutes(
  app: FastifyInstance,
  repo: IPersonaPreferencesRepository,
): void {
  // GET /v1/preferences — 获取当前偏好（FR-PER-001）
  app.get("/v1/preferences", async (req, reply) => {
    const tenant = resolveTenant(req);
    const prefs = await repo.get(tenant);
    if (!prefs) {
      // BR-PER-001：未配置时返回中性默认值
      return reply.send({
        id: null,
        tone: "neutral" as const,
        proactiveness: "medium" as const,
        addressForm: "none" as const,
        reminderCadence: "moderate" as const,
        version: 0,
        skipped: false,
      });
    }
    return reply.send(prefs);
  });

  // POST /v1/preferences — 首次填写问卷或跳过（FR-PER-001）
  app.post("/v1/preferences", async (req, reply) => {
    const tenant = resolveTenant(req);
    const parsed = savePersonaPreferencesSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation failed", details: parsed.error.issues });
    }

    // BR-PER-002：安全规则覆盖（安全边界不可通过偏好修改）
    // 安全规则由安全模块独立判断，此处仅做偏好存储

    const prefs = await repo.save(tenant, parsed.data);
    return reply.status(201).send(prefs);
  });

  // PATCH /v1/preferences — 单项或多项修改（FR-PER-002）
  app.patch("/v1/preferences", async (req, reply) => {
    const tenant = resolveTenant(req);
    const parsed = updatePersonaPreferencesSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation failed", details: parsed.error.issues });
    }

    const prefs = await repo.update(tenant, parsed.data);
    return reply.send(prefs);
  });

  // POST /v1/preferences/reset — 重置为中性默认值（FR-PER-002）
  app.post("/v1/preferences/reset", async (req, reply) => {
    const tenant = resolveTenant(req);
    const prefs = await repo.reset(tenant);
    return reply.send(prefs);
  });
}