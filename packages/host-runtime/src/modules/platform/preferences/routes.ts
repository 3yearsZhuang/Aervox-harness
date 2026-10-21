/**
 * Aervox｜思隅 @aervox/api — 偏好路由（CAP-010 人格问卷与基础偏好）
 *
 * 覆盖：FR-PER-001（问卷/跳过）、FR-PER-002（修改/重置）、BR-PER-001（中性默认值）、BR-PER-002（安全覆盖）
 */
import type { FastifyInstance } from "fastify";
import type { IPersonaPreferencesRepository } from "@aervox/repositories";
import {
  preferencesApi,
  type SavePreferencesRequest,
  type UpdatePreferencesRequest,
} from "@aervox/contracts";
import { resolveLocalContext } from "../../../shared/local-context.js";
import { registerContractRoute } from "../../../shared/contract-route.js";

export function registerPreferencesRoutes(
  app: FastifyInstance,
  repo: IPersonaPreferencesRepository,
): void {
  // GET /v1/preferences — 获取当前偏好（FR-PER-001）
  registerContractRoute(app, preferencesApi.get, async (req) => {
    const tenant = resolveLocalContext(req);
    const prefs = await repo.get(tenant);
    if (!prefs) {
      // BR-PER-001：未配置时返回中性默认值
      return {
        id: null,
        tone: "neutral" as const,
        proactiveness: "medium" as const,
        addressForm: "none" as const,
        reminderCadence: "moderate" as const,
        version: 0,
        skipped: false,
      };
    }
    return prefs;
  });

  // POST /v1/preferences — 首次填写问卷或跳过（FR-PER-001）
  registerContractRoute(app, preferencesApi.save, async (req) => {
    const tenant = resolveLocalContext(req);

    // BR-PER-002：安全规则覆盖（安全边界不可通过偏好修改）
    // 安全规则由安全模块独立判断，此处仅做偏好存储

    return repo.save(tenant, req.body as SavePreferencesRequest);
  });

  // PATCH /v1/preferences — 单项或多项修改（FR-PER-002）
  registerContractRoute(app, preferencesApi.update, async (req) => {
    const tenant = resolveLocalContext(req);
    return repo.update(tenant, req.body as UpdatePreferencesRequest);
  });

  // POST /v1/preferences/reset — 重置为中性默认值（FR-PER-002）
  registerContractRoute(app, preferencesApi.reset, async (req) => {
    const tenant = resolveLocalContext(req);
    return repo.reset(tenant);
  });
}
