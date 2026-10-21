/**
 * Aervox｜思隅 @aervox/api — 隐私域路由（用户侧：同意授权 + 删除请求）
 *
 * 删除传播与 RecoveryControlLedger 内部账本由 Worker 处理，不对外暴露。
 */
import { privacyApi, type ConsentQuery, type CreateDeletionRequest, type GrantConsentRequest } from "@aervox/contracts";
import type { FastifyInstance } from "fastify";
import type { SqlitePrivacyRepository } from "@aervox/repositories";
import { resolveLocalContext } from "../../../shared/local-context.js";
import { registerContractRoute } from "../../../shared/contract-route.js";

let seq = 0;
const id = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}_${(++seq).toString(36)}`;

export function registerPrivacyRoutes(
  app: FastifyInstance,
  privacyRepo: SqlitePrivacyRepository,
): void {
  registerContractRoute(app, privacyApi.grantConsent, async (req) => {
    const tenant = resolveLocalContext(req);
    const body = req.body as GrantConsentRequest;
    const grant = await privacyRepo.grantConsent(tenant, {
      id: id("cg"),
      actorId: tenant.actorId ?? tenant.subjectUserId,
      purpose: body.purpose,
      scope: body.scope,
      policyVersion: body.policyVersion,
    });
    return grant;
  });

  registerContractRoute(app, privacyApi.revokeConsent, async (req, reply) => {
    const { grantId } = req.params as { grantId: string };
    const grant = await privacyRepo.revokeConsent(resolveLocalContext(req), grantId);
    if (!grant) return reply.code(404).send({ error: "consent grant not found" });
    return grant;
  });

  registerContractRoute(app, privacyApi.activeConsent, async (req) => {
    const { purpose, scope } = req.query as ConsentQuery;
    if (!purpose || !scope) return { active: false };
    const active = await privacyRepo.hasActiveConsent(resolveLocalContext(req), purpose, scope);
    return { purpose, scope, active };
  });

  registerContractRoute(app, privacyApi.createDeletion, async (req, reply) => {
    const tenant = resolveLocalContext(req);
    const body = req.body as CreateDeletionRequest;
    // 同一请求内按 (targetType, targetId) 去重：复合主键冲突会让整批写入失败（500）；
    // 同键不同 ownerModule 属声明歧义，fail-closed 拒绝而不是任选其一。
    let targets: Array<{ targetType: string; targetId: string; ownerModule: string }> | undefined;
    if (body.targets) {
      const byKey = new Map<string, { targetType: string; targetId: string; ownerModule: string }>();
      for (const target of body.targets) {
        const key = `${target.targetType}\u0000${target.targetId}`;
        const existing = byKey.get(key);
        if (existing && existing.ownerModule !== target.ownerModule) {
          return reply.code(400).send({ error: "conflicting ownerModule for duplicate target" });
        }
        byKey.set(key, target);
      }
      targets = [...byKey.values()];
    }
    const request = await privacyRepo.createDeletionRequest(tenant, {
      id: id("dr"),
      scope: body.scope,
      idempotencyKey: body.idempotencyKey ?? id("del"),
      ownerModule: body.ownerModule,
      targets,
    });
    return request;
  });
}
