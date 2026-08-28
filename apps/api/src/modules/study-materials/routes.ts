/**
 * Aervox｜思隅 @aervox/api — 学习资料路由（CAP-011）
 *
 * 覆盖：
 * - FR-LRN-002 资料生成与类型（5 种资料类型，引用可追溯）
 * - FR-LRN-003 资料编辑与导出（版本链，JSON/Markdown 导出）
 * - BR-LRN-001 事实核验、版权与删除传播（来源许可证，核验状态，删除失效引用）
 */
import type { FastifyInstance } from "fastify";
import type { IStudyMaterialRepository } from "@aervox/database";
import {
  createStudyMaterialSchema,
  editStudyMaterialSchema,
  exportFormatSchema,
} from "@aervox/contracts";
import { resolveTenant } from "../../shared/tenant.js";

let seq = 0;

export function registerStudyMaterialRoutes(
  app: FastifyInstance,
  repo: IStudyMaterialRepository,
): void {
  // POST /v1/study-materials — 生成资料（FR-LRN-002）
  app.post("/v1/study-materials", async (req, reply) => {
    const tenant = resolveTenant(req);
    const parsed = createStudyMaterialSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation failed", details: parsed.error.issues });
    }

    const materialId = `mat_${Date.now().toString(36)}_${(++seq).toString(36)}`;
    const idempotencyKey = (req.headers["idempotency-key"] as string) ?? undefined;

    // 幂等检查（FR-LRN-002 AC-03）
    if (idempotencyKey) {
      const existing = await repo.getByIdempotencyKey(tenant, idempotencyKey);
      if (existing) {
        return reply.status(200).send(existing);
      }
    }

    // 创建资料身份
    const material = await repo.create(tenant, {
      id: materialId,
      goalId: parsed.data.goalId,
      type: parsed.data.type,
      title: parsed.data.title,
      idempotencyKey,
    });

    // 创建首版内容
    const versionId = `mv_${Date.now().toString(36)}_${(++seq).toString(36)}`;
    await repo.createVersion(tenant, {
      id: versionId,
      materialId,
      content: parsed.data.content,
      format: parsed.data.format,
      author: "model",
    });

    // 添加引用来源（BR-LRN-001）
    for (const source of parsed.data.sources) {
      await repo.addSource(tenant, {
        id: `src_${Date.now().toString(36)}_${(++seq).toString(36)}`,
        materialVersionId: versionId,
        sourceType: source.sourceType,
        sourceUri: source.sourceUri,
        sourceTitle: source.sourceTitle,
        licenseStatus: source.licenseStatus,
        verificationStatus: source.verificationStatus,
      });
    }

    const updated = await repo.get(tenant, materialId);
    const currentVersion = updated?.currentVersionId ? await repo.getVersion(tenant, updated.currentVersionId) : null;
    const sources = currentVersion ? await repo.listSources(tenant, currentVersion.id) : [];
    return reply.status(201).send({ ...updated, currentVersion, sources });
  });

  // GET /v1/study-materials — 列表（按目标或租户）
  app.get("/v1/study-materials", async (req, reply) => {
    const tenant = resolveTenant(req);
    const { goalId } = req.query as { goalId?: string };
    const materials = goalId
      ? await repo.listByGoal(tenant, goalId)
      : await repo.listByTenant(tenant);
    return reply.send({ items: materials });
  });

  // GET /v1/study-materials/:id — 获取资料详情
  app.get("/v1/study-materials/:id", async (req, reply) => {
    const tenant = resolveTenant(req);
    const { id } = req.params as { id: string };
    const material = await repo.get(tenant, id);
    if (!material) {
      return reply.status(404).send({ error: "Material not found" });
    }

    // 获取当前版本和引用来源
    let currentVersion = null;
    let sources: unknown[] = [];
    if (material.currentVersionId) {
      currentVersion = await repo.getVersion(tenant, material.currentVersionId);
      if (currentVersion) {
        sources = await repo.listSources(tenant, material.currentVersionId);
      }
    }

    return reply.send({ ...material, currentVersion, sources });
  });

  // PATCH /v1/study-materials/:id — 编辑资料（FR-LRN-003）
  app.patch("/v1/study-materials/:id", async (req, reply) => {
    const tenant = resolveTenant(req);
    const { id } = req.params as { id: string };
    const parsed = editStudyMaterialSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation failed", details: parsed.error.issues });
    }

    const material = await repo.get(tenant, id);
    if (!material || material.status === "deleted") {
      return reply.status(404).send({ error: "Material not found or deleted" });
    }

    const newVersion = await repo.editVersion(tenant, id, parsed.data.content, parsed.data.expectedVersion);
    if (!newVersion) {
      return reply.status(409).send({ error: "Version conflict or no active version" });
    }

    return reply.send(newVersion);
  });

  // GET /v1/study-materials/:id/versions — 版本历史（FR-LRN-003 AC-01）
  app.get("/v1/study-materials/:id/versions", async (req, reply) => {
    const tenant = resolveTenant(req);
    const { id } = req.params as { id: string };
    const versions = await repo.listVersions(tenant, id);
    return reply.send({ materialId: id, versions });
  });

  // POST /v1/study-materials/:id/export — 导出资料（FR-LRN-003 AC-02）
  app.post("/v1/study-materials/:id/export", async (req, reply) => {
    const tenant = resolveTenant(req);
    const { id } = req.params as { id: string };
    const { format = "markdown" } = (req.body ?? {}) as { format?: string };

    const parsed = exportFormatSchema.safeParse(format);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid format, use 'json' or 'markdown'" });
    }

    const material = await repo.get(tenant, id);
    if (!material) {
      return reply.status(404).send({ error: "Material not found" });
    }

    let currentVersion = null;
    let sources: unknown[] = [];
    if (material.currentVersionId) {
      currentVersion = await repo.getVersion(tenant, material.currentVersionId);
      if (currentVersion) {
        sources = await repo.listSources(tenant, material.currentVersionId);
      }
    }

    // RFC 5987：非 ASCII 文件名用 filename* 编码，避免 HTTP 头非法字符
    const safeFilename = encodeURIComponent(material.title);

    if (parsed.data === "json") {
      return reply
        .header("Content-Type", "application/json")
        .header("Content-Disposition", `attachment; filename*=UTF-8''${safeFilename}.json`)
        .send({
          material: {
            id: material.id,
            type: material.type,
            title: material.title,
            status: material.status,
          },
          version: currentVersion,
          sources,
          exportedAt: new Date().toISOString(),
        });
    }

    // Markdown 导出
    const md = [
      `# ${material.title}`,
      "",
      `> 类型: ${material.type} | 状态: ${material.status} | 导出时间: ${new Date().toISOString()}`,
      "",
      currentVersion?.content ?? "",
      "",
      "## 引用来源",
      ...(sources as { sourceType: string; sourceUri?: string; sourceTitle?: string; licenseStatus: string; verificationStatus: string }[]).map(
        (s) => `- [${s.sourceType}] ${s.sourceTitle ?? s.sourceUri ?? "N/A"} (许可证: ${s.licenseStatus}, 核验: ${s.verificationStatus})`,
      ),
    ].join("\n");

    return reply
      .header("Content-Type", "text/markdown; charset=utf-8")
      .header("Content-Disposition", `attachment; filename*=UTF-8''${safeFilename}.md`)
      .send(md);
  });

  // DELETE /v1/study-materials/:id — 软删除（BR-LRN-001 AC-03）
  app.delete("/v1/study-materials/:id", async (req, reply) => {
    const tenant = resolveTenant(req);
    const { id } = req.params as { id: string };
    const deleted = await repo.softDelete(tenant, id);
    if (!deleted) {
      return reply.status(404).send({ error: "Material not found or already deleted" });
    }

    // 失效关联引用来源
    const versions = await repo.listVersions(tenant, id);
    for (const v of versions) {
      await repo.invalidateSources(tenant, v.id);
    }

    return reply.send({ id, deletedAt: deleted.deletedAt });
  });
}