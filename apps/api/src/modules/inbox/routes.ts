/**
 * Aervox｜思隅 @aervox/api — 受控收件箱（Agent Inbox）路由（阶段 5a-2）
 *
 * 规则依据：docs/reference/agent-harness-loop.md §7.2 + ADR-017。
 * POST /v1/sessions/:sessionId/inbox — followup / steer / inject 三 command 统一入口：
 * - 服务端强校验：consumeBoundary 与 type 匹配（followup→next-turn；steer→next-step；inject 皆可）；
 * - sourceActor 由服务端按调用方身份注入：缺省 user；携带 x-plugin-id 时校验插件
 *   已安装且启用 + 具备 inbox.command 权限后注入 plugin；客户端不自报 actor；
 * - 幂等：同 idempotencyKey（租户内）重复提交返回既有项（200），新建返回 201。
 */
import type { FastifyInstance } from "fastify";
import { createInboxItemRequestSchema } from "@aervox/contracts";
import type { SqliteAgentInboxRepository, SqliteExtensionRepository } from "@aervox/database";
import { resolveTenant } from "../../shared/tenant.js";

let seq = 0;
const nextId = (): string => `ibx_${Date.now().toString(36)}_${(++seq).toString(36)}`;

/** 插件提交 inbox command 所需权限（由 hasPluginPermission 检查，ADR-017「受限 inbox command」） */
export const PLUGIN_INBOX_PERMISSION = "inbox.command";

export interface InboxRouteDeps {
  inboxRepo: SqliteAgentInboxRepository;
  extensionRepo: SqliteExtensionRepository;
}

export function registerInboxRoutes(app: FastifyInstance, deps: InboxRouteDeps): void {
  app.post("/v1/sessions/:sessionId/inbox", async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    const tenant = resolveTenant(req);

    // 请求体校验（type/payload/幂等键/consumeBoundary 一致性）
    const parsed = createInboxItemRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_inbox_command",
        message: "type/payload/idempotencyKey 必填；followup→next-turn、steer→next-step",
      });
    }
    const body = parsed.data;
    if (body.sessionId !== undefined && body.sessionId !== sessionId) {
      return reply.code(400).send({
        error: "session_id_mismatch",
        message: "body.sessionId 必须与路径参数一致",
      });
    }
    if (body.payload === undefined) {
      return reply.code(400).send({ error: "invalid_inbox_command", message: "payload 必填" });
    }
    const idempotencyKey = (req.headers["idempotency-key"] as string | undefined) ?? body.idempotencyKey;

    // 插件身份注入：x-plugin-id → 插件已安装且启用 + 具备 inbox.command 权限，否则 403
    let sourceActor: "user" | "plugin" = "user";
    const pluginId = req.headers["x-plugin-id"] as string | undefined;
    if (pluginId !== undefined) {
      const plugin = await deps.extensionRepo.getPlugin(pluginId);
      if (!plugin || plugin.enabled !== 1) {
        return reply.code(403).send({
          error: "plugin_forbidden",
          message: "x-plugin-id 对应插件未安装或未启用",
        });
      }
      const granted = await deps.extensionRepo.hasPluginPermission(tenant, pluginId, PLUGIN_INBOX_PERMISSION);
      if (!granted) {
        return reply.code(403).send({
          error: "plugin_permission_denied",
          message: `插件缺少 ${PLUGIN_INBOX_PERMISSION} 权限`,
        });
      }
      sourceActor = "plugin";
    }

    // 幂等：同 idempotencyKey 已存在 → 返回既有项（重复提交安全）
    const existing = await deps.inboxRepo.getByIdempotencyKey(tenant, idempotencyKey);
    if (existing) return reply.code(200).send(existing);

    const item = await deps.inboxRepo.enqueue(tenant, {
      id: nextId(),
      idempotencyKey,
      sessionId,
      attemptId: body.attemptId ?? null,
      stepId: null,
      type: body.type,
      sourceActor,
      payload: body.payload,
      consumeBoundary: body.consumeBoundary,
      expiresAt: body.expiresAt ?? null,
    });
    return reply.code(201).send(item);
  });
}