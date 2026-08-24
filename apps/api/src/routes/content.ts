/**
 * Aervox｜思隅 @aervox/api — 内容域路由（用户侧：附件元数据）
 *
 * 大对象正文存储于对象存储，业务库仅存元数据。
 */
import type { FastifyInstance } from "fastify";
import type { RepoContainer } from "../container.js";
import { resolveTenant } from "../tenant.js";

let seq = 0;
const id = (): string => `att_${Date.now().toString(36)}_${(++seq).toString(36)}`;

export function registerContentRoutes(app: FastifyInstance, c: RepoContainer): void {
  app.post("/v1/attachments", async (req, reply) => {
    const tenant = resolveTenant(req);
    const body = (req.body ?? {}) as {
      objectKey?: string;
      mediaType?: string;
      size?: number;
      sourceLicense?: string;
    };
    if (!body.objectKey || !body.mediaType) {
      return reply.code(400).send({ error: "objectKey and mediaType are required" });
    }
    const attachment = await c.content.createAttachment(tenant, {
      id: id(),
      objectKey: body.objectKey,
      mediaType: body.mediaType,
      size: body.size,
      sourceLicense: body.sourceLicense,
    });
    return reply.code(201).send(attachment);
  });

  app.get("/v1/attachments/:attachmentId", async (req, reply) => {
    const { attachmentId } = req.params as { attachmentId: string };
    const attachment = await c.content.getAttachment(resolveTenant(req), attachmentId);
    if (!attachment) return reply.code(404).send({ error: "attachment not found" });
    return attachment;
  });
}
