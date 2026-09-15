/**
 * Aervox｜思隅 @aervox/api — 项目管理与外部会话导入路由（CR-048 / W3）
 *
 * 支撑工作台项目维度聚合、会话归属分配与历史会话导入。
 */
import type { FastifyInstance } from "fastify";
import {
  createProjectRequestSchema,
  updateProjectRequestSchema,
  importSessionRequestSchema,
} from "@aervox/contracts";
import type {
  SqliteProjectRepository,
  SqliteConversationRepository,
} from "@aervox/repositories";
import { resolveLocalContext } from "../../shared/local-context.js";

export function registerProjectRoutes(
  app: FastifyInstance,
  projectRepo: SqliteProjectRepository,
  conversationRepo: SqliteConversationRepository,
): void {
  // GET /v1/projects — 获取项目列表
  app.get("/v1/projects", async (req, reply) => {
    const tenant = resolveLocalContext(req);
    const { includeArchived } = req.query as { includeArchived?: string };
    const items = await projectRepo.listProjects(tenant, {
      includeArchived: includeArchived === "true" || includeArchived === "1",
    });
    return reply.send({ items });
  });

  // POST /v1/projects — 创建项目
  app.post("/v1/projects", async (req, reply) => {
    const tenant = resolveLocalContext(req);
    const parsed = createProjectRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
    }
    const created = await projectRepo.createProject(tenant, parsed.data);
    return reply.code(201).send(created);
  });

  // PATCH /v1/projects/:projectId — 更新或归档项目
  app.patch("/v1/projects/:projectId", async (req, reply) => {
    const tenant = resolveLocalContext(req);
    const { projectId } = req.params as { projectId: string };
    const parsed = updateProjectRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
    }
    const updated = await projectRepo.updateProject(tenant, projectId, parsed.data);
    if (!updated) {
      return reply.code(404).send({ error: "Project not found" });
    }
    return reply.send(updated);
  });

  // DELETE /v1/projects/:projectId — 删除项目（解绑会话）
  app.delete("/v1/projects/:projectId", async (req, reply) => {
    const tenant = resolveLocalContext(req);
    const { projectId } = req.params as { projectId: string };
    const deleted = await projectRepo.deleteProject(tenant, projectId);
    if (!deleted) {
      return reply.code(404).send({ error: "Project not found" });
    }
    return reply.code(204).send();
  });

  // POST /v1/sessions/import — 导入外部会话
  app.post("/v1/sessions/import", async (req, reply) => {
    const tenant = resolveLocalContext(req);
    const parsed = importSessionRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
    }
    const result = await conversationRepo.importSession(tenant, parsed.data);
    return reply.code(201).send(result);
  });
}
