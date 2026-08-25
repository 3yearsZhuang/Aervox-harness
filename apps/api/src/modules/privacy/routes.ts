/**
 * Aervox｜思隅 @aervox/api — 隐私域路由（用户侧：同意授权 + 删除请求）
 *
 * 删除传播与 RecoveryControlLedger 内部账本由 Worker 处理，不对外暴露。
 */
import type { FastifyInstance } from "fastify";
import type { SqlitePrivacyRepository } from "@aervox/database";
import { resolveTenant } from "../../shared/tenant.js";

let seq = 0;
const id = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}_${(++seq).toString(36)}`;

export function registerPrivacyRoutes(
  app: FastifyInstance,
  privacyRepo: SqlitePrivacyRepository,
): void {
  app.post("/v1/consent", async (req, reply) => {
    const tenant = resolveTenant(req);
    const body = (req.body ?? {}) as {
      actorId?: string;
      purpose?: string;
      scope?: string;
      policyVersion?: string;
    };
    if (!body.purpose || !body.scope || !body.policyVersion) {
      return reply.code(400).send({ error: "purpose, scope and policyVersion are required" });
    }
    const grant = await privacyRepo.grantConsent(tenant, {
      id: id("cg"),
      actorId: body.actorId ?? tenant.actorId ?? tenant.subjectUserId,
      purpose: body.purpose,
      scope: body.scope,
      policyVersion: body.policyVersion,
    });
    return reply.code(201).send(grant);
  });

  app.post("/v1/consent/:grantId/revoke", async (req, reply) => {
    const { grantId } = req.params as { grantId: string };
    const grant = await privacyRepo.revokeConsent(resolveTenant(req), grantId);
    if (!grant) return reply.code(404).send({ error: "consent grant not found" });
    return grant;
  });

  app.get("/v1/consent", async (req) => {
    const { purpose, scope } = req.query as { purpose?: string; scope?: string };
    if (!purpose || !scope) return { active: false };
    const active = await privacyRepo.hasActiveConsent(resolveTenant(req), purpose, scope);
    return { purpose, scope, active };
  });

  app.post("/v1/deletions", async (req, reply) => {
    const tenant = resolveTenant(req);
    const body = (req.body ?? {}) as {
      scope?: string;
      idempotencyKey?: string;
      ownerModule?: string;
    };
    if (!body.scope || !body.ownerModule) {
      return reply.code(400).send({ error: "scope and ownerModule are required" });
    }
    const request = await privacyRepo.createDeletionRequest(tenant, {
      id: id("dr"),
      scope: body.scope,
      idempotencyKey: body.idempotencyKey ?? id("del"),
      ownerModule: body.ownerModule,
    });
    return reply.code(202).send(request);
  });
}