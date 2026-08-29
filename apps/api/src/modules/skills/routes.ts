/**
 * Aervox｜思隅 @aervox/api — Skill 管理路由（CAP-020）
 *
 * 基础：
 * - GET    /v1/skills                 列出技能（?activeOnly=true 仅启用）；
 * - POST   /v1/skills                 安装技能（zip base64，可含单/多技能）；
 * - GET    /v1/skills/prompt          渐进式披露提示词段（运行时注入用）；
 * - GET    /v1/skills/:name           技能元数据；
 * - GET    /v1/skills/:name/content   SKILL.md 全文（模型按需读取）；
 * - PATCH  /v1/skills/:name           启停（active 开关）；
 * - DELETE /v1/skills/:name           删除（readonly 技能拒绝）。
 *
 * Neo 生命周期：
 * - POST   /v1/skills/payloads                创建不可变内容载荷；
 * - GET    /v1/skills/payloads/:ref           读取载荷；
 * - POST   /v1/skills/candidates              创建候选（绑定来源证据）；
 * - GET    /v1/skills/candidates              列出候选（?skillKey=&status=）；
 * - POST   /v1/skills/candidates/:id/evaluate 评估候选；
 * - POST   /v1/skills/candidates/:id/promote  晋升（canary/stable + 可选本地同步）；
 * - GET    /v1/skills/releases                列出发布（?skillKey=&stage=&activeOnly=）；
 * - POST   /v1/skills/releases/:id/rollback   回滚发布；
 * - POST   /v1/skills/releases/:id/sync       同步 stable 发布到本地。
 */
import type { FastifyInstance } from "fastify";
import { FileExistsError, type SkillManager } from "./skill-manager.js";
import { SkillNotFoundError, SkillStateError, type SkillLifecycleService } from "./lifecycle.js";

export function registerSkillRoutes(
  app: FastifyInstance,
  manager: SkillManager,
  lifecycle?: SkillLifecycleService,
): void {
  // 列出
  app.get("/v1/skills", async (req) => {
    const { activeOnly, source } = (req.query ?? {}) as { activeOnly?: string; source?: string };
    let items = await manager.listSkills(activeOnly === "true");
    if (source) {
      items = items.filter((s) => s.source === source);
    }
    return { items };
  });

  // 安装（zip base64）
  app.post("/v1/skills", async (req, reply) => {
    const body = (req.body ?? {}) as {
      name?: string;
      overwrite?: boolean;
      zipBase64?: string;
    };
    if (!body.zipBase64 || typeof body.zipBase64 !== "string") {
      return reply.code(400).send({ error: "zipBase64 is required" });
    }
    let zipData: Buffer;
    try {
      zipData = Buffer.from(body.zipBase64, "base64");
    } catch {
      return reply.code(400).send({ error: "zipBase64 is not valid base64" });
    }
    try {
      const installed = await manager.installFromZip(zipData, {
        name: body.name,
        overwrite: body.overwrite,
      });
      return reply.code(201).send({ installed });
    } catch (err) {
      if (err instanceof FileExistsError) {
        return reply.code(409).send({ error: err.message });
      }
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 渐进式披露提示词段
  app.get("/v1/skills/prompt", async () => ({ prompt: await manager.buildPrompt() }));

  // 技能元数据
  app.get("/v1/skills/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    const skill = await manager.getSkill(name);
    if (!skill) return reply.code(404).send({ error: "skill not found" });
    return skill;
  });

  // SKILL.md 全文
  app.get("/v1/skills/:name/content", async (req, reply) => {
    const { name } = req.params as { name: string };
    const content = await manager.readSkillMarkdown(name);
    if (!content) return reply.code(404).send({ error: "skill not found" });
    return content;
  });

  // 启停
  app.patch("/v1/skills/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    const body = (req.body ?? {}) as { active?: boolean };
    if (typeof body.active !== "boolean") {
      return reply.code(400).send({ error: "active is required" });
    }
    const skill = await manager.setActive(name, body.active);
    if (!skill) return reply.code(404).send({ error: "skill not found" });
    return skill;
  });

  // 删除（readonly 拒绝 → 409）
  app.delete("/v1/skills/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    const ok = await manager.deleteSkill(name);
    if (!ok) return reply.code(409).send({ error: "delete failed（技能不存在或为只读）" });
    return reply.code(204).send();
  });

  if (!lifecycle) return;

  // ---- Neo 生命周期 ----

  // 创建载荷
  app.post("/v1/skills/payloads", async (req, reply) => {
    const body = (req.body ?? {}) as { payloadRef?: string; kind?: string; payload?: unknown };
    if (body.payload === undefined) {
      return reply.code(400).send({ error: "payload is required" });
    }
    const payload = await lifecycle.createPayload({
      payloadRef: body.payloadRef,
      kind: body.kind,
      payload: body.payload,
    });
    return reply.code(201).send(payload);
  });

  // 读取载荷
  app.get("/v1/skills/payloads/:ref", async (req, reply) => {
    const { ref } = req.params as { ref: string };
    const payload = await lifecycle.getPayload(ref);
    if (!payload) return reply.code(404).send({ error: "payload not found" });
    return payload;
  });

  // 创建候选
  app.post("/v1/skills/candidates", async (req, reply) => {
    const body = (req.body ?? {}) as {
      skillKey?: string;
      sourceEvidence?: { turnIds?: string[]; memoryIds?: string[]; learningItemIds?: string[] };
      payloadRef?: string | null;
      scenarioKey?: string | null;
    };
    if (!body.skillKey) {
      return reply.code(400).send({ error: "skillKey is required" });
    }
    const candidate = await lifecycle.createCandidate({
      skillKey: body.skillKey,
      sourceEvidence: body.sourceEvidence,
      payloadRef: body.payloadRef,
      scenarioKey: body.scenarioKey,
    });
    return reply.code(201).send(candidate);
  });

  // 列出候选
  app.get("/v1/skills/candidates", async (req) => {
    const { skillKey, status } = (req.query ?? {}) as { skillKey?: string; status?: string };
    const items = await lifecycle.listCandidates({ skillKey, status });
    return { items };
  });

  // 评估候选
  app.post("/v1/skills/candidates/:candidateId/evaluate", async (req, reply) => {
    const { candidateId } = req.params as { candidateId: string };
    const body = (req.body ?? {}) as { passed?: boolean; score?: number; report?: string };
    if (typeof body.passed !== "boolean") {
      return reply.code(400).send({ error: "passed is required" });
    }
    try {
      const candidate = await lifecycle.evaluateCandidate(candidateId, {
        passed: body.passed,
        score: body.score,
        report: body.report,
      });
      return candidate;
    } catch (err) {
      if (err instanceof SkillNotFoundError) return reply.code(404).send({ error: err.message });
      if (err instanceof SkillStateError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  // 晋升候选
  app.post("/v1/skills/candidates/:candidateId/promote", async (req, reply) => {
    const { candidateId } = req.params as { candidateId: string };
    const body = (req.body ?? {}) as { stage?: "canary" | "stable"; syncToLocal?: boolean };
    try {
      const release = await lifecycle.promoteCandidate(candidateId, {
        stage: body.stage,
        syncToLocal: body.syncToLocal,
      });
      return release;
    } catch (err) {
      if (err instanceof SkillNotFoundError) return reply.code(404).send({ error: err.message });
      if (err instanceof SkillStateError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  // 列出发布
  app.get("/v1/skills/releases", async (req) => {
    const { skillKey, stage, activeOnly } = (req.query ?? {}) as {
      skillKey?: string;
      stage?: string;
      activeOnly?: string;
    };
    const items = await lifecycle.listReleases({
      skillKey,
      stage,
      activeOnly: activeOnly === "true",
    });
    return { items };
  });

  // 回滚发布
  app.post("/v1/skills/releases/:releaseId/rollback", async (req, reply) => {
    const { releaseId } = req.params as { releaseId: string };
    try {
      const result = await lifecycle.rollbackRelease(releaseId);
      return result;
    } catch (err) {
      if (err instanceof SkillNotFoundError) return reply.code(404).send({ error: err.message });
      throw err;
    }
  });

  // 同步 stable 发布到本地
  app.post("/v1/skills/releases/:releaseId/sync", async (req, reply) => {
    const { releaseId } = req.params as { releaseId: string };
    try {
      const release = await lifecycle.syncRelease(releaseId);
      return release;
    } catch (err) {
      if (err instanceof SkillNotFoundError) return reply.code(404).send({ error: err.message });
      if (err instanceof SkillStateError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });
}
