/**
 * Aervox｜思隅 @aervox/api — 内容域路由（CAP-012 多模态答疑）
 *
 * 覆盖：
 * - FR-EXT-001 附件上传与用途声明（格式/大小校验，扫描管线）
 * - FR-EXT-002 解析、预览与纠正（OCR 结果，裁剪，转文字）
 * - BR-EXT-001 OCR 置信度与低置信处理（幂等重试，不臆测）
 * - BR-EXT-002 附件保留与删除传播（级联清除派生物）
 */
import type { FastifyInstance } from "fastify";
import path from "node:path";
import fsp from "node:fs/promises";
import type { SqliteContentRepository } from "@aervox/database";
import {
  createAttachmentSchema,
  parseAttachmentSchema,
  cropParseResultSchema,
  convertToTextSchema,
  allowedMediaTypesSchema,
  attachmentPurposeSchema,
  MAX_ATTACHMENT_SIZE,
  OCR_CONFIDENCE_THRESHOLD,
} from "@aervox/contracts";
import { resolveTenant } from "../../shared/tenant.js";

let seq = 0;
const nextId = (prefix: string): string => `${prefix}_${Date.now().toString(36)}_${(++seq).toString(36)}`;

/** 文件名净化：去路径分隔符与控制字符，限长，空则回退 "unnamed" */
function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[\\/\u0000-\u001f<>:"|?*]/g, "_").trim();
  return cleaned.slice(0, 120) || "unnamed";
}

/** 由 MIME 类型推断安全扩展名（含前导点；未知类型空串） */
function extensionForMediaType(mediaType: string): string {
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
    "text/markdown": ".md",
    "text/csv": ".csv",
    "application/msword": ".doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/ogg": ".ogg",
    "audio/mp4": ".m4a",
    "audio/webm": ".weba",
  };
  return map[mediaType] ?? "";
}

/** 模拟 OCR 解析（实际应接入 OCR 服务） */
function mockOcrParse(_objectKey: string): { text: string; confidence: number } {
  // 模拟解析结果：置信度随机 0.5-0.95
  const confidence = 0.5 + Math.random() * 0.45;
  const text = confidence >= OCR_CONFIDENCE_THRESHOLD
    ? "1. 已知函数 f(x) = 2x + 3，求 f(5) 的值。\n2. 解方程：3x - 7 = 14。"
    : "[解析置信度低，内容可能不完整]";
  return { text, confidence: Math.round(confidence * 100) / 100 };
}

export function registerContentRoutes(
  app: FastifyInstance,
  contentRepo: SqliteContentRepository,
  attachmentsRoot: string,
): void {
  // ============ FR-EXT-001：附件上传与用途声明 ============

  // POST /v1/attachments — 上传附件（FR-EXT-001 AC-01）
  app.post("/v1/attachments", async (req, reply) => {
    const tenant = resolveTenant(req);
    const parsed = createAttachmentSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Validation failed",
        details: parsed.error.issues,
        // FR-EXT-001 AC-01：展示允许格式和大小
        allowedFormats: allowedMediaTypesSchema.options,
        maxSize: MAX_ATTACHMENT_SIZE,
      });
    }

    const idempotencyKey = parsed.data.idempotencyKey;
    // 幂等检查（BR-EXT-001 AC-02：重试不重复）
    if (idempotencyKey) {
      const existing = await contentRepo.getAttachmentByIdempotencyKey(tenant, idempotencyKey);
      if (existing) {
        const parseResult = await contentRepo.getActiveParseResult(tenant, existing.id);
        return reply.status(200).send({ ...existing, parseResult });
      }
    }

    // FR-EXT-001 AC-02：上传后进入扫描管线
    const attachment = await contentRepo.createAttachment(tenant, {
      id: nextId("att"),
      objectKey: parsed.data.objectKey,
      mediaType: parsed.data.mediaType,
      size: parsed.data.size,
      scanStatus: "clean", // 模拟扫描通过
      sourceLicense: parsed.data.sourceLicense,
      purpose: parsed.data.purpose,
      idempotencyKey,
    });

    return reply.status(201).send(attachment);
  });

  // POST /v1/attachments/binary — 原始二进制上传（多模态输入：图片/音频/文档）
  // Web 端 fetch 直接以 File 为 body；桌面端经 IPC 桥转发 Buffer。
  // 查询参数：fileName / mediaType / purpose / idempotencyKey（均必填除 idempotencyKey）。
  app.register(async (scope) => {
    // 独立作用域注册通配 content-type parser，避免影响全局 JSON 解析行为
    scope.addContentTypeParser(
      "*",
      { parseAs: "buffer" },
      (_req, body, done) => done(null, body),
    );

    scope.post(
      "/v1/attachments/binary",
      { bodyLimit: MAX_ATTACHMENT_SIZE },
      async (req, reply) => {
        const tenant = resolveTenant(req);
        const query = (req.query ?? {}) as Record<string, string | undefined>;
        const fileName = sanitizeFileName(query.fileName ?? "");
        const mediaType = query.mediaType ?? "";
        const purpose = query.purpose ?? "";

        if (!allowedMediaTypesSchema.options.includes(mediaType as never)) {
          return reply.status(400).send({
            error: "Unsupported media type",
            allowedFormats: allowedMediaTypesSchema.options,
            maxSize: MAX_ATTACHMENT_SIZE,
          });
        }
        if (!attachmentPurposeSchema.options.includes(purpose as never)) {
          return reply.status(400).send({ error: "Invalid purpose" });
        }

        const body = req.body;
        if (!Buffer.isBuffer(body) || body.byteLength === 0) {
          return reply.status(400).send({ error: "Empty or invalid body" });
        }
        if (body.byteLength > MAX_ATTACHMENT_SIZE) {
          return reply.status(413).send({ error: "Attachment too large", maxSize: MAX_ATTACHMENT_SIZE });
        }

        const idempotencyKey = query.idempotencyKey;
        if (idempotencyKey) {
          const existing = await contentRepo.getAttachmentByIdempotencyKey(tenant, idempotencyKey);
          if (existing) {
            return reply.status(200).send(existing);
          }
        }

        const id = nextId("att");
        const objectKey = `${id}_${fileName}${extensionForMediaType(mediaType)}`;
        await fsp.mkdir(attachmentsRoot, { recursive: true });
        await fsp.writeFile(path.join(attachmentsRoot, objectKey), body);

        const attachment = await contentRepo.createAttachment(tenant, {
          id,
          objectKey,
          mediaType,
          size: body.byteLength,
          scanStatus: "clean", // 模拟扫描通过
          purpose,
          idempotencyKey,
        });
        return reply.status(201).send(attachment);
      },
    );
  });

  // GET /v1/attachments/:id/content — 回读附件二进制（预览/回放）
  app.get("/v1/attachments/:attachmentId/content", async (req, reply) => {
    const tenant = resolveTenant(req);
    const { attachmentId } = req.params as { attachmentId: string };
    const attachment = await contentRepo.getAttachment(tenant, attachmentId);
    if (!attachment) {
      return reply.status(404).send({ error: "Attachment not found" });
    }
    const filePath = path.join(attachmentsRoot, path.basename(attachment.objectKey));
    let content: Buffer;
    try {
      content = await fsp.readFile(filePath);
    } catch {
      return reply.status(404).send({ error: "Attachment content missing" });
    }
    return reply
      .header("Content-Type", attachment.mediaType)
      .header("Content-Length", content.byteLength)
      .send(content);
  });

  // GET /v1/attachments/:id — 获取附件详情 + 当前解析结果
  app.get("/v1/attachments/:attachmentId", async (req, reply) => {
    const tenant = resolveTenant(req);
    const { attachmentId } = req.params as { attachmentId: string };
    const attachment = await contentRepo.getAttachment(tenant, attachmentId);
    if (!attachment) {
      return reply.status(404).send({ error: "Attachment not found" });
    }
    const parseResult = await contentRepo.getActiveParseResult(tenant, attachmentId);
    return reply.send({ ...attachment, parseResult });
  });

  // ============ FR-EXT-002：解析、预览与纠正 ============

  // POST /v1/attachments/:id/parse — 触发解析（FR-EXT-002 AC-01, BR-EXT-001 AC-02）
  app.post("/v1/attachments/:attachmentId/parse", async (req, reply) => {
    const tenant = resolveTenant(req);
    const { attachmentId } = req.params as { attachmentId: string };
    const parsed = parseAttachmentSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation failed", details: parsed.error.issues });
    }

    const attachment = await contentRepo.getAttachment(tenant, attachmentId);
    if (!attachment) {
      return reply.status(404).send({ error: "Attachment not found" });
    }

    // FR-EXT-001 AC-02：未通过扫描不得用于答疑
    if (attachment.scanStatus !== "clean") {
      return reply.status(403).send({ error: "Attachment has not passed scan" });
    }

    const idempotencyKey = parsed.data.idempotencyKey ?? `parse_${attachmentId}`;
    // BR-EXT-001 AC-02：幂等重试不重复产生解析结果
    const existing = await contentRepo.getParseResultByIdempotencyKey(tenant, idempotencyKey);
    if (existing) {
      return reply.status(200).send(existing);
    }

    // 取代旧解析结果（如果存在）
    const oldActive = await contentRepo.getActiveParseResult(tenant, attachmentId);
    if (oldActive) {
      await contentRepo.supersedeParseResult(tenant, oldActive.id);
    }

    // 模拟 OCR 解析
    const ocrResult = mockOcrParse(attachment.objectKey);
    const parseStatus = ocrResult.confidence >= OCR_CONFIDENCE_THRESHOLD
      ? "completed"
      : "low_confidence"; // BR-EXT-001 AC-01

    const result = await contentRepo.createParseResult(tenant, {
      id: nextId("apr"),
      attachmentId,
      parseStatus,
      parsedText: ocrResult.text,
      confidence: Math.round(ocrResult.confidence * 100), // 存储为整数百分比
      operation: "ocr",
      idempotencyKey,
    });

    return reply.status(201).send(result);
  });

  // PATCH /v1/attachments/:id/parse/crop — 裁剪解析结果（FR-EXT-002 AC-01）
  app.patch("/v1/attachments/:attachmentId/parse/crop", async (req, reply) => {
    const tenant = resolveTenant(req);
    const { attachmentId } = req.params as { attachmentId: string };
    const parsed = cropParseResultSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation failed", details: parsed.error.issues });
    }

    const attachment = await contentRepo.getAttachment(tenant, attachmentId);
    if (!attachment) {
      return reply.status(404).send({ error: "Attachment not found" });
    }

    // 取代旧解析结果
    const oldActive = await contentRepo.getActiveParseResult(tenant, attachmentId);
    if (oldActive) {
      await contentRepo.supersedeParseResult(tenant, oldActive.id);
    }

    // 创建裁剪后的新解析结果（裁剪覆盖原解析结果）
    const result = await contentRepo.createParseResult(tenant, {
      id: nextId("apr"),
      attachmentId,
      parseStatus: "completed",
      parsedText: oldActive?.parsedText ?? "",
      confidence: 100, // 用户确认裁剪，置信度设为满
      cropData: parsed.data.cropData,
      operation: "crop",
    });

    return reply.send(result);
  });

  // POST /v1/attachments/:id/parse/convert-text — 转文字（BR-EXT-001 AC-01）
  app.post("/v1/attachments/:attachmentId/parse/convert-text", async (req, reply) => {
    const tenant = resolveTenant(req);
    const { attachmentId } = req.params as { attachmentId: string };
    const parsed = convertToTextSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation failed", details: parsed.error.issues });
    }

    const attachment = await contentRepo.getAttachment(tenant, attachmentId);
    if (!attachment) {
      return reply.status(404).send({ error: "Attachment not found" });
    }

    // 取代旧解析结果
    const oldActive = await contentRepo.getActiveParseResult(tenant, attachmentId);
    if (oldActive) {
      await contentRepo.supersedeParseResult(tenant, oldActive.id);
    }

    // 创建转文字结果（用户手动输入，置信度满）
    const result = await contentRepo.createParseResult(tenant, {
      id: nextId("apr"),
      attachmentId,
      parseStatus: "completed",
      parsedText: parsed.data.text,
      confidence: 100,
      operation: "text",
    });

    return reply.status(201).send(result);
  });

  // GET /v1/attachments/:id/parse/history — 解析历史
  app.get("/v1/attachments/:attachmentId/parse/history", async (req, reply) => {
    const tenant = resolveTenant(req);
    const { attachmentId } = req.params as { attachmentId: string };
    const attachment = await contentRepo.getAttachment(tenant, attachmentId);
    if (!attachment) {
      return reply.status(404).send({ error: "Attachment not found" });
    }
    const results = await contentRepo.listParseResults(tenant, attachmentId);
    return reply.send({ attachmentId, results });
  });

  // ============ BR-EXT-002：附件删除与传播 ============

  // DELETE /v1/attachments/:id — 删除附件及派生物（BR-EXT-002 AC-01）
  app.delete("/v1/attachments/:attachmentId", async (req, reply) => {
    const tenant = resolveTenant(req);
    const { attachmentId } = req.params as { attachmentId: string };

    // 失效所有解析结果（OCR/缩略图/向量等派生物）
    const invalidatedCount = await contentRepo.invalidateParseResults(tenant, attachmentId);

    // 软删除附件
    const deleted = await contentRepo.softDeleteAttachment(tenant, attachmentId);
    if (!deleted) {
      return reply.status(404).send({ error: "Attachment not found or already deleted" });
    }

    return reply.send({
      id: attachmentId,
      deletedAt: deleted.deletedAt,
      invalidatedDerivatives: invalidatedCount,
    });
  });
}
