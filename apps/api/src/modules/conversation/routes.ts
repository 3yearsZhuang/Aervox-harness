/**
 * Aervox｜思隅 @aervox/api — 会话/流式协议路由
 *
 * 规则依据：docs/reference/STREAMING_PROTOCOL.md + @aervox/contracts + AVX-HAR-001（阶段 1）。
 * 迁移自原单文件 index.ts，并补充 Message 身份写链路；SSE 事件来自持久 turn_stream_events，
 * Turn 创建后由 Agent Loop（Replay Provider）执行并写事件。
 */
import type { FastifyInstance } from "fastify";
import {
  createTurnRequestSchema,
  editMessageSchema,
  submitQuestionAnswersRequestSchema,
} from "@aervox/contracts";
import type { SkillDescriptor } from "@aervox/agent-loop";
import type {
  SqliteConversationRepository,
  SqlitePrivacyRepository,
  SqliteAgentInboxRepository,
  SqliteSubagentRunRepository,
  SqlitePlatformRepository,
} from "@aervox/database";
import type { ToolRuntime } from "../tools/runtime.js";
import type { LLMConfigService } from "../llm/service.js";
import { resolveTenant } from "../../shared/tenant.js";
import { createTenantInboxPort } from "../inbox/port.js";
import { runLoopTurnOnce } from "./agent-executor.js";
import { UserQuestionCoordinator } from "./user-question-coordinator.js";
import { loadApiConfig } from "@aervox/config";
import type { ProactiveActionAuthorizer } from "../proactive/action-authorizer.js";

let seq = 0;
const nextTurnId = (): string => `turn_${Date.now().toString(36)}_${(++seq).toString(36)}`;

export interface ConversationRouteDeps {
  /** 阶段 2d：Agent Loop 只读工具提供者（缺失时工具请求 fail-closed） */
  toolRuntime?: ToolRuntime;
  /** 阶段 2e：AERVOX_LOOP_PROVIDER=llm 时的模型配置来源（CR-015） */
  llmConfigService?: LLMConfigService;
  /** 2d：删除/撤权闸门数据源（缺失时 Loop 不做删除 fail-closed） */
  privacyRepo?: SqlitePrivacyRepository;
  /** 5a-2：受控收件箱（followup 排队为新 Turn 输入；next-step 由 Loop 每 Step 消费） */
  inboxRepo?: SqliteAgentInboxRepository;
  /** 5b：Skill 渐进披露清单加载器（activeOnly；缺省不注入 Skills 段） */
  skillLoader?: () => Promise<SkillDescriptor[]>;
  /** 5c：Subagent 委托执行器工厂（request 级 tenant 绑定；注入则贡献 subagent_delegate 工具） */
  subagentFactory?: (tenant: import("@aervox/database").TenantContext) => import("@aervox/agent-loop").SubagentPort;
  /** 5c：已注册 Workflow 定义清单（贡献 workflow_run 工具；GET /v1/workflows 元数据） */
  workflows?: import("@aervox/agent-loop").WorkflowDefinition[];
  /** 5c：subagent_runs 仓储（GET /v1/turns/:id/subagents 审计查询） */
  subagentRunRepo?: SqliteSubagentRunRepository;
  /** 阶段 7：ModelRun/ContextManifest 落库口（Step 级可追溯写入；缺失则不记录） */
  platformRepo?: SqlitePlatformRepository;
  /** UQ-01：向用户提问会话协调器 */
  userQuestionCoordinator?: UserQuestionCoordinator;
  /** CAP-016：刷题模式作答落库端口工厂（request 级 tenant 绑定） */
  practiceAttemptFactory?: (tenant: import("@aervox/database").TenantContext) => import("@aervox/agent-loop").PracticeAttemptPort;
  /** CAP-033：主动智能全动作授权与本地动作账本。 */
  proactiveActionAuthorizer?: ProactiveActionAuthorizer;
  /** CAP-033：本地画像上下文来源。 */
  proactiveRepository?: import("@aervox/database").IProactiveProfileRepository;
}

export function registerConversationRoutes(
  app: FastifyInstance,
  conversationRepo: SqliteConversationRepository,
  deps: ConversationRouteDeps = {},
): void {
  // POST /v1/sessions/{sessionId}/turns — 幂等创建 Turn 并原子写入 Outbox
  app.post("/v1/sessions/:sessionId/turns", async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    const parsed = createTurnRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        code: "MODEL_TIMEOUT" as const,
        retryable: false,
        message: "Invalid create turn request",
        lastSequence: 0,
      });
    }

    const idempotencyKey =
      (req.headers["idempotency-key"] as string) ||
      `idem_${Date.now().toString(36)}_${(++seq).toString(36)}`;

    const tenant = resolveTenant(req);

    // 确保会话存在（turns.session_id 外键引用 sessions）
    await conversationRepo.getOrCreateSession(tenant, sessionId, "Aervox 会话");

    // 检查幂等性
    const existingTurn = await conversationRepo.getTurnByIdempotencyKey(tenant, idempotencyKey);
    if (existingTurn) {
      return reply.code(200).send({
        turnId: existingTurn.id,
        status: existingTurn.status,
        eventsUrl: `/v1/turns/${existingTurn.id}/events`,
        cancelUrl: `/v1/turns/${existingTurn.id}/cancel`,
      });
    }

    let userMessage = parsed.data.message.content;

    // 多模态输入（CAP-012）：消息携带附件引用时附加结构化清单，
    // Agent Loop 消费 userMessage 即可感知附件（图片/音频/文档），后续接 OCR/转写管线。
    const attachments = parsed.data.message.attachments ?? [];
    if (attachments.length > 0) {
      const list = attachments
        .map((a) => `- ${a.name ?? a.attachmentId}${a.mediaType ? ` (${a.mediaType})` : ""} [id: ${a.attachmentId}]`)
        .join("\n");
      userMessage = `${userMessage}\n\n[附件清单]\n${list}`;
    }

    // 阶段 5a-2：消费本 session 的 next-turn 收件箱项（followup 排队为新 Turn 输入，§7.2）
    if (deps.inboxRepo) {
      const followups = await deps.inboxRepo.claimForConsumption(tenant, {
        sessionId,
        type: "next-turn",
        limit: 20,
      });
      if (followups.length > 0) {
        const extra = followups.map((f) =>
          typeof f.payload === "string" ? f.payload : JSON.stringify(f.payload),
        );
        await deps.inboxRepo.acknowledge(
          tenant,
          followups.map((f) => f.id),
        );
        userMessage = [...extra, userMessage].join("\n\n");
      }
    }

    const turnId = nextTurnId();
    const messageId = `msg_${Date.now().toString(36)}_${(++seq).toString(36)}`;

    await conversationRepo.createTurnWithOutbox(
      tenant,
      { id: turnId, sessionId, idempotencyKey, status: "Created" },
      { id: messageId, content: userMessage },
      {
        id: `outbox_${turnId}`,
        eventType: "turn.created",
        idempotencyKey: `idem_outbox_${turnId}`,
        payload: { turnId, sessionId },
      },
    );

    // 阶段 1/2d（AVX-HAR-001 §15）：创建 Attempt 并由 Agent Loop 执行一次。
    // CR-027：Loop 执行与 HTTP 响应解耦——background（默认）落库后立即 201，
    // Loop 后台执行，客户端经 SSE 活流（重放 + tail + 心跳）观察进度；
    // 深度思考等长回合不再把 POST 拖过客户端超时。inline 保留旧同步语义（测试/排查）。
    const attemptId = `atp_${turnId}`;
    await conversationRepo.createTurnAttempt(tenant, turnId, { id: attemptId, attempt: 1 });
    const uqPort = deps.userQuestionCoordinator ? deps.userQuestionCoordinator.createPort(tenant) : undefined;
    const practiceAttemptPort = deps.practiceAttemptFactory ? deps.practiceAttemptFactory(tenant) : undefined;
    const runLoop = async () =>
      runLoopTurnOnce(
      conversationRepo,
      tenant,
      {
        turnId,
        sessionId,
        attemptId,
        userMessage,
      },
      {
        toolRuntime: deps.toolRuntime,
        llmConfigService: deps.llmConfigService,
        // 2d：删除/撤权水位未追平 → Loop fail-closed（AVX-HAR-001 §11.3）
        deletionGate: deps.privacyRepo
          ? { isBlocked: async () => deps.privacyRepo!.hasPendingDeletionRequest(tenant) }
          : undefined,
        // 5a-2：受控收件箱端口（每 Step 消费 next-step；steer/inject 注入上下文）
        inbox: deps.inboxRepo ? createTenantInboxPort(deps.inboxRepo, tenant) : undefined,
        // 5b：Skill 渐进披露（activeOnly 清单注入 system prompt）
        skills: deps.skillLoader ? await deps.skillLoader() : undefined,
        // 5c：Subagent/Workflow Contribution（独立 Tool/Provider 组合；惰性工厂按 request tenant 绑定）
        subagentFactory: deps.subagentFactory,
        workflows: deps.workflows,
        // 阶段 7：Step 级 ModelRun + 每 Turn ContextManifest 快照落库
        platformRepo: deps.platformRepo,
        // UQ-01: 向用户提问端口
        userQuestionPort: uqPort,
        // CAP-016: 刷题模式作答落库端口
        practiceAttemptPort,
        proactiveActionAuthorizer: deps.proactiveActionAuthorizer,
        proactiveRepository: deps.proactiveRepository,
      },
    );
    if (loadApiConfig().turnExecution === "inline") {
      await runLoop();
    } else {
      // 后台执行：异常已在 runLoopTurnOnce 内部落 error 事件 + Failed 终态，此处仅兜底防 unhandledRejection
      void runLoop().catch(() => undefined);
    }

    return reply.code(201).send({
      turnId,
      status: "Created" as const,
      eventsUrl: `/v1/turns/${turnId}/events`,
      cancelUrl: `/v1/turns/${turnId}/cancel`,
    });
  });

  // GET /v1/turns/{turnId}/events — SSE 事件流（CR-027：重放持久事件 + 活流 tail）
  // 先全量重放已落库 turn_stream_events；若 Attempt 未达终态则持续轮询增量并按节拍发
  // SSE 注释心跳（`: ping`），直至 Attempt 终态（ Completed/Failed/Interrupted/Cancelled）
  // 事件排空后结束。深度思考等长回合期间客户端始终有数据流入，不再出现整段静默。
  app.get("/v1/turns/:turnId/events", async (req, reply) => {
    const { turnId } = req.params as { turnId: string };
    const tenant = resolveTenant(req);
    const origin = (req.headers.origin as string | undefined) ?? "*";
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
    });

    const TAIL_POLL_INTERVAL_MS = 400;
    const TAIL_HEARTBEAT_MS = 15_000;
    const TAIL_MAX_DURATION_MS = 10 * 60_000;

    const writeEventFrame = (ev: {
      id: string;
      turnId: string;
      sequence: number;
      eventType: string;
      payloadVersion: number;
      occurredAt: string;
      data: unknown;
    }): void => {
      const body = {
        eventId: ev.id,
        turnId: ev.turnId,
        sequence: ev.sequence,
        eventType: ev.eventType,
        payloadVersion: ev.payloadVersion,
        occurredAt: ev.occurredAt,
        data: ev.data,
      };
      raw.write(`id: ${ev.id}\n`);
      raw.write(`data: ${JSON.stringify(body)}\n\n`);
    };

    let closed = false;
    let tailTimer: ReturnType<typeof setInterval> | undefined;
    const finish = (): void => {
      if (closed) return;
      closed = true;
      if (tailTimer) clearInterval(tailTimer);
      raw.end();
    };
    req.raw.on("close", finish);
    raw.on("close", finish);

    // 1) 重放已落库事件（断线重连亦由此恢复全量序列）
    const persisted = await conversationRepo.getStreamEvents(tenant, turnId, 0);
    let lastSequence = 0;
    let lastWriteAt = Date.now();
    for (const ev of persisted) {
      writeEventFrame(ev);
      lastSequence = Math.max(lastSequence, ev.sequence);
    }

    const attemptSettled = async (): Promise<boolean> => {
      const attempts = await conversationRepo.listTurnAttempts(tenant, turnId);
      const terminal = ["Completed", "Failed", "Interrupted", "Cancelled"];
      return attempts.length > 0 && attempts.every((a) => terminal.includes(a.status));
    };

    // 2) Attempt 已终态（inline 模式/历史回合）：重放即完整，直接结束（旧语义兼容）
    if (closed || (await attemptSettled())) {
      finish();
      return;
    }

    // 3) 活流 tail：轮询增量 + 心跳，直至 Attempt 终态或超时上限
    const tailStartedAt = Date.now();
    let polling = false;
    tailTimer = setInterval(() => {
      if (closed || polling) return;
      polling = true;
      void (async () => {
        try {
          const fresh = await conversationRepo.getStreamEvents(tenant, turnId, lastSequence);
          for (const ev of fresh) {
            writeEventFrame(ev);
            lastSequence = Math.max(lastSequence, ev.sequence);
            lastWriteAt = Date.now();
          }
          if (Date.now() - lastWriteAt >= TAIL_HEARTBEAT_MS) {
            raw.write(`: ping\n\n`);
            lastWriteAt = Date.now();
          }
          if (Date.now() - tailStartedAt >= TAIL_MAX_DURATION_MS || (await attemptSettled())) {
            // 终态后再排空一次（终态提交与 done/error 事件同事务，此处仅兜底）
            const remaining = await conversationRepo.getStreamEvents(tenant, turnId, lastSequence);
            for (const ev of remaining) {
              writeEventFrame(ev);
              lastSequence = Math.max(lastSequence, ev.sequence);
            }
            finish();
          }
        } catch {
          finish();
        } finally {
          polling = false;
        }
      })();
    }, TAIL_POLL_INTERVAL_MS);
  });

  // POST /v1/turns/{turnId}/cancel — 取消 Turn（AVX-HAR-001 §11.1：Attempt CAS 置 CancelRequested，executor 检查点中止）
  app.post("/v1/turns/:turnId/cancel", async (req, reply) => {
    const { turnId } = req.params as { turnId: string };
    const tenant = resolveTenant(req);
    const attempts = await conversationRepo.listTurnAttempts(tenant, turnId);
    const running = attempts.find((a) => a.status === "Running");
    if (!running) {
      const latest = attempts[0];
      return reply.code(latest ? 409 : 404).send({
        error: latest ? "turn_already_finalized" : "turn_not_found",
        turnId,
        status: latest?.status ?? "Unknown",
      });
    }
    const res = await conversationRepo.requestCancelTurnAttempt(tenant, {
      turnId,
      attemptId: running.id,
    });
    if (!res.ok) {
      const latest = attempts[0];
      return reply.code(409).send({ error: res.reason ?? "request_cancel_failed", turnId, status: latest?.status });
    }
    return reply.send({ turnId, status: "Cancelled", cancelled: true });
  });

  // POST /v1/turns/{turnId}/questions/answers — 提交对向用户询问的回答 (UQ-01)
  app.post("/v1/turns/:turnId/questions/answers", async (req, reply) => {
    const { turnId } = req.params as { turnId: string };
    const tenant = resolveTenant(req);
    if (!deps.userQuestionCoordinator) {
      return reply.code(404).send({ error: "user_questions_disabled" });
    }
    const parsed = submitQuestionAnswersRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_request",
        details: parsed.error.issues,
      });
    }
    try {
      const res = await deps.userQuestionCoordinator.submitAnswers(
        tenant,
        turnId,
        parsed.data.answers,
      );
      return reply.send(res);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("NO_PENDING_QUESTION")) {
        return reply.code(409).send({ error: msg });
      }
      return reply.code(500).send({ error: msg });
    }
  });

  // GET /v1/turns/{turnId}/questions/pending — 查询当前 Turn 待作答问题 (UQ-01)
  app.get("/v1/turns/:turnId/questions/pending", async (req, reply) => {
    const { turnId } = req.params as { turnId: string };
    if (!deps.userQuestionCoordinator) {
      return reply.code(404).send({ error: "user_questions_disabled" });
    }
    const tenant = resolveTenant(req);
    const pending = await deps.userQuestionCoordinator.getPending(tenant, turnId);
    if (!pending) {
      return reply.send({ turnId, pending: false, questions: [] });
    }
    return reply.send({ turnId, pending: true, step: pending.step, questions: pending.questions });
  });

  // POST /v1/turns/{turnId}/tool-approvals — 写工具授权决定（阶段 3a：grant / deny；3b：privileged 仅管理员可批准）
  app.post("/v1/turns/:turnId/tool-approvals", async (req, reply) => {
    const { turnId } = req.params as { turnId: string };
    const tenant = resolveTenant(req);
    const body = (req.body ?? {}) as { approvalId?: string; decision?: string; decidedBy?: string };
    if (!body.approvalId || (body.decision !== "granted" && body.decision !== "denied")) {
      return reply.code(400).send({ error: "approvalId and decision (granted|denied) are required" });
    }
    // 3b：privileged 工具的管理员身份校验（AERVOX_ADMIN_IDS 白名单 + x-admin-user-id）
    if (deps.toolRuntime) {
      const approval = await conversationRepo.getToolApproval(tenant, body.approvalId);
      if (!approval) {
        return reply.code(404).send({ error: "approval not found" });
      }
      const registrations = await deps.toolRuntime.listTools();
      const tool = registrations.find((t) => t.name === approval.toolName);
      if (tool?.safetyLevel === "privileged") {
        const adminId = req.headers["x-admin-user-id"] as string | undefined;
        // 缺陷 E：管理员白名单经 @aervox/config 集中解析（AERVOX_ADMIN_IDS）
        const allowed = loadApiConfig().adminIds;
        if (adminId === undefined || !allowed.includes(adminId)) {
          return reply.code(403).send({ error: "admin_required: privileged tool approval requires x-admin-user-id in AERVOX_ADMIN_IDS" });
        }
      }
    }
    const updated = await conversationRepo.decideToolApproval(tenant, body.approvalId, body.decision, body.decidedBy ?? "admin");
    if (!updated) {
      return reply.code(404).send({ error: "approval not found" });
    }
    // 决定留痕为流事件（SSE 重放可见；授权后的执行由客户端重发相同请求命中 granted）
    // 序号 = 当前最大序号 + 1（与执行器/协调器并发追加安全）
    const events = await conversationRepo.getStreamEvents(tenant, turnId, 0);
    const lastSequence = events.reduce((max, event) => Math.max(max, event.sequence), 0);
    await conversationRepo.appendStreamEvent(tenant, {
      id: `tev_${Date.now().toString(36)}`,
      turnId,
      sequence: lastSequence + 1,
      eventType: body.decision === "granted" ? "tool_approval_granted" : "tool_approval_denied",
      data: { approvalId: updated.id, decision: updated.state, toolName: updated.toolName },
    });
    return reply.send({ approvalId: updated.id, state: updated.state });
  });

  // 阶段 5c：子任务审计（subagent_runs；租户隔离；返回父 Turn 委托的全部子任务运行记录）
  app.get("/v1/turns/:turnId/subagents", async (req, reply) => {
    const { turnId } = req.params as { turnId: string };
    const tenant = resolveTenant(req);
    if (!deps.subagentRunRepo) {
      return reply.code(404).send({ error: "subagent_runs_disabled" });
    }
    const runs = await deps.subagentRunRepo.listRunsByTurn(tenant, turnId);
    return reply.send({ turnId, runs });
  });

  // 阶段 5c：Workflow 注册清单（元数据；执行经 `workflow_run` 工具，不在此直接触发）
  app.get("/v1/workflows", async (_req, reply) => {
    const workflows = (deps.workflows ?? []).map((w) => ({
      name: w.name,
      description: w.description,
      steps: w.steps.map((s) => s.description),
    }));
    return reply.send({ workflows });
  });

  // POST /v1/messages — 创建消息身份（身份与版本分离的写链路）
  app.post("/v1/messages", async (req, reply) => {
    const tenant = resolveTenant(req);
    const body = (req.body ?? {}) as { sessionId?: string; role?: string; label?: string };
    if (!body.sessionId || !body.role) {
      return reply.code(400).send({ error: "sessionId and role are required" });
    }
    const message = await conversationRepo.createMessage(tenant, {
      id: `msg_${Date.now().toString(36)}_${(++seq).toString(36)}`,
      sessionId: body.sessionId,
      role: body.role,
      label: body.label,
    });
    return reply.code(201).send(message);
  });

  // ============ CAP-013：消息编辑、删除、版本历史、恢复 ============

  // PATCH /v1/messages/:messageId — 编辑消息（FR-CONV-004）
  app.patch("/v1/messages/:messageId", async (req, reply) => {
    const { messageId } = req.params as { messageId: string };
    const tenant = resolveTenant(req);
    const parsed = editMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Validation failed", details: parsed.error.issues });
    }

    const result = await conversationRepo.editMessage(
      tenant,
      messageId,
      parsed.data.content,
      parsed.data.expectedVersion,
    );

    if (!result) {
      // AC-FR-CONV-004-02：消息已删除或版本不匹配
      return reply.code(409).send({
        error: "Message deleted or version conflict",
        messageId,
      });
    }

    return reply.send({
      message: result.message,
      newVersion: result.newVersion,
    });
  });

  // DELETE /v1/messages/:messageId — 软删除消息（FR-CONV-005）
  app.delete("/v1/messages/:messageId", async (req, reply) => {
    const { messageId } = req.params as { messageId: string };
    const tenant = resolveTenant(req);

    const deleted = await conversationRepo.softDeleteMessage(tenant, messageId);
    if (!deleted) {
      return reply.code(404).send({ error: "Message not found or already deleted" });
    }

    return reply.send({ messageId, deletedAt: deleted.deletedAt });
  });

  // GET /v1/messages/:messageId/delete-impact — 删除影响预览（FR-CONV-005）
  app.get("/v1/messages/:messageId/delete-impact", async (req, reply) => {
    const { messageId } = req.params as { messageId: string };
    const tenant = resolveTenant(req);

    const message = await conversationRepo.getMessage(tenant, messageId);
    if (!message) {
      return reply.code(404).send({ error: "Message not found" });
    }

    // 派生影响预览：检查关联的摘要、错题、复习项、日记和记忆
    // AC-FR-CONV-005-01：展示受影响派生清单
    const impacts: { type: "summary" | "mistake" | "review" | "diary" | "memory"; id: string; description: string }[] = [];

    // 检查 message_versions 关联的 turn → 关联的派生数据
    const versions = await conversationRepo.listMessageVersions(tenant, messageId);
    const turnIds = [...new Set(versions.map((v) => v.turnId))];

    for (const turnId of turnIds) {
      impacts.push({
        type: "summary",
        id: turnId,
        description: `Turn ${turnId} 的摘要可能引用此消息`,
      });
    }

    return reply.send({
      messageId,
      impacts,
      totalAffected: impacts.length,
    });
  });

  // POST /v1/messages/:messageId/restore — 恢复已删除消息
  app.post("/v1/messages/:messageId/restore", async (req, reply) => {
    const { messageId } = req.params as { messageId: string };
    const tenant = resolveTenant(req);

    const restored = await conversationRepo.restoreMessage(tenant, messageId);
    if (!restored) {
      return reply.code(404).send({ error: "Message not found" });
    }

    return reply.send(restored);
  });

  // GET /v1/messages/:messageId/versions — 消息版本历史（FR-CONV-004）
  app.get("/v1/messages/:messageId/versions", async (req, reply) => {
    const { messageId } = req.params as { messageId: string };
    const tenant = resolveTenant(req);

    const versions = await conversationRepo.listMessageVersions(tenant, messageId);
    return reply.send({ messageId, versions });
  });
}
