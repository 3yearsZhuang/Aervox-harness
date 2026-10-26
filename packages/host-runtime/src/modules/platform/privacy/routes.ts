/**
 * Aervox｜思隅 @aervox/api — 隐私域路由（用户侧：同意授权 + 删除请求）
 *
 * 删除传播与 RecoveryControlLedger 内部账本由 Worker 处理，不对外暴露。
 */
import { privacyApi, type ConsentQuery, type CreateDeletionRequest, type GrantConsentRequest } from "@aervox/contracts";
import type { FastifyInstance } from "fastify";
import { DomainConflictError, type SqlitePrivacyRepository } from "@aervox/repositories";
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
    // Target normalization belongs to the transactional command; the HTTP
    // adapter only preserves the existing 400 response for ambiguous owners.
    try {
      return await privacyRepo.createDeletionRequest(tenant, {
        id: id("dr"),
        scope: body.scope,
        idempotencyKey: body.idempotencyKey ?? id("del"),
        ownerModule: body.ownerModule,
        targets: body.targets,
      });
    } catch (error) {
      if (error instanceof DomainConflictError && error.message === "deletion_target_owner_conflict") {
        return reply.code(400).send({ error: "conflicting ownerModule for duplicate target" });
      }
      throw error;
    }
  });
}
