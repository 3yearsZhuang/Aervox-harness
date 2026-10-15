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
  createSessionRequestSchema,
  renameSessionRequestSchema,
} from "@aervox/contracts";
import {
  type SqliteConversationRepository,
  type SqlitePrivacyRepository,
  type SqliteAgentInboxRepository,
  type SqliteSubagentRunRepository,
  type SqlitePlatformRepository,
} from "@aervox/repositories";
import { resolveLocalContext } from "../../../shared/local-context.js";
import { acceptConversationTurn } from "./application.js";
import { turnStreamHub, type StreamEventFrame } from "./stream-hub.js";
import { loadApiConfig } from "@aervox/config";

let seq = 0;
const nextTurnId = (): string => `turn_${Date.now().toString(36)}_${(++seq).toString(36)}`;

export type { ConversationRouteDeps } from "./execution.js";
import { executeConversationTurn, type ConversationRouteDeps, type ConversationTurnInput } from "./execution.js";

export function registerConversationRoutes(
  app: FastifyInstance,
  conversationRepo: SqliteConversationRepository,
  deps: ConversationRouteDeps = {},
  execute?: (input: ConversationTurnInput) => Promise<void>,
): void {
  // Accepted local turns own cancellation independently of HTTP/SSE connections.
  const activeTurns = new Map<string, AbortController>();
  app.addHook("onClose", async () => {
    for (const controller of activeTurns.values()) controller.abort(new Error("host_closed"));
    activeTurns.clear();
  });
  // GET /v1/sessions — 枚举会话列表（按最近更新时间排序）
  app.get("/v1/sessions", async (req, reply) => {
    const tenant = resolveLocalContext(req);
    const { limit, offset, projectId } = req.query as {
      limit?: string;
      offset?: string;
      projectId?: string;
    };
    const parsedLimit = limit ? Number.parseInt(limit, 10) : 100;
    const parsedOffset = offset ? Number.parseInt(offset, 10) : 0;
    const items = await conversationRepo.listSessions(tenant, {
      limit: Number.isFinite(parsedLimit) && parsedLimit >= 0 ? parsedLimit : 100,
      offset: Number.isFinite(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0,
      projectId: projectId || undefined,
    });
    return reply.send({ items });
  });

  // POST /v1/sessions — 创建新会话
  app.post("/v1/sessions", async (req, reply) => {
    const tenant = resolveLocalContext(req);
    const parsed = createSessionRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
    }
    const title = parsed.data.title || "新会话";
    let session;
    if (parsed.data.id) {
      session = await conversationRepo.getOrCreateSession(tenant, parsed.data.id, title, parsed.data.projectId);
    } else {
      session = await conversationRepo.createSession(tenant, title, { projectId: parsed.data.projectId });
    }
    return reply.code(201).send(session);
  });

  // PATCH /v1/sessions/:sessionId — 重命名或更新会话
  app.patch("/v1/sessions/:sessionId", async (req, reply) => {
    const tenant = resolveLocalContext(req);
    const { sessionId } = req.params as { sessionId: string };
    const parsed = renameSessionRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid request", details: parsed.error.issues });
    }
    const updated = await conversationRepo.renameSession(tenant, sessionId, {
      title: parsed.data.title,
      projectId: parsed.data.projectId,
    });
    if (!updated) {
      return reply.code(404).send({ error: "Session not found" });
    }
    return reply.send(updated);
  });

  // DELETE /v1/sessions/:sessionId — 删除会话（级联删除 turns/messages）
  app.delete("/v1/sessions/:sessionId", async (req, reply) => {
    const tenant = resolveLocalContext(req);
    const { sessionId } = req.params as { sessionId: string };
    const deleted = await conversationRepo.deleteSession(tenant, sessionId);
    if (!deleted) {
      return reply.code(404).send({ error: "Session not found" });
    }
    return reply.code(204).send();
  });

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

    const tenant = resolveLocalContext(req);

    // 确保会话存在（turns.session_id 外键引用 sessions）
    await conversationRepo.getOrCreateSession(tenant, sessionId, "Aervox 会话");

    // 检查幂等性
    const existingTurn = await conversationRepo.getTurnByIdempotencyKey(tenant, idempotencyKey);
    if (existingTurn) {
      if (existingTurn.sessionId !== sessionId) return reply.code(409).send({ code: "IDEMPOTENCY_KEY_REUSED" });
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

    const turnId = nextTurnId();
    const messageId = `msg_${Date.now().toString(36)}_${(++seq).toString(36)}`;
    const attemptId = `atp_${turnId}`;
    const executionConfig = loadApiConfig();
    const execution = executionConfig.turnExecution === "inline" ? "api" : executionConfig.loopDispatch;
    const accepted = await acceptConversationTurn(conversationRepo, tenant, {
      execution, metadata: parsed.data.metadata, toolApprovalMode: parsed.data.toolApprovalMode, actorId: tenant.actorId,
      turnId, sessionId, idempotencyKey, attemptId,
      message: { id: messageId, content: userMessage }, consumeInbox: Boolean(deps.inboxRepo),
    });
    if (!accepted.created) {
      return reply.code(200).send({
        turnId: accepted.turn.id, status: accepted.turn.status,
        eventsUrl: `/v1/turns/${accepted.turn.id}/events`, cancelUrl: `/v1/turns/${accepted.turn.id}/cancel`,
      });
    }
    // Execute precisely the persisted input; only the committing request dispatches the Loop.
    userMessage = accepted.message.content;
    // CR-027: acceptance remains independent of background execution and SSE observation.
    const runLoop = async () => {
      const controller = new AbortController();
      activeTurns.set(turnId, controller);
      try {
        await (execute ?? (input => executeConversationTurn(conversationRepo, tenant, input, deps)))({
          turnId, sessionId, attemptId, userMessage, metadata: parsed.data.metadata,
          toolApprovalMode: parsed.data.toolApprovalMode, actorId: tenant.actorId, signal: controller.signal,
        });
      } finally {
        if (activeTurns.get(turnId) === controller) activeTurns.delete(turnId);
        controller.abort(new Error("turn_execution_finished"));
      }
    };
    if (executionConfig.turnExecution === "inline") {
      await runLoop();
    } else if (execution === "worker" && accepted.turn.dispatchTarget !== "api") {
      deps.observability?.log.info({
        event: "turn.dispatched_to_worker",
        message: `Turn ${turnId} dispatched to background worker via outbox`,
        fields: { turnId, sessionId },
      });
    } else {
      // 后台执行：异常已在 runLoop 内部捕获并推进 Failed 终态，此处仅兜底防 unhandledRejection
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
  // 先订阅进程内总线并重放已落库 turn_stream_events；若 Attempt 未达终态则接收实时增量，
  // 仅按节拍发送 SSE 注释心跳（`: ping`），直至 Attempt 终态（Completed/Failed/Interrupted/Cancelled）
  // 事件排空后结束。深度思考等长回合期间客户端始终有数据流入，不再出现整段静默。
  app.get("/v1/turns/:turnId/events", async (req, reply) => {
    const { turnId } = req.params as { turnId: string };
    const tenant = resolveLocalContext(req);
    const origin = (req.headers.origin as string | undefined) ?? "*";
    const query = req.query as Record<string, unknown>;
    const queryCursor = typeof query.after === "string" && query.after.trim() ? query.after.trim() : undefined;
    const headerValue = req.headers["last-event-id"];
    const headerCursor = typeof headerValue === "string" && headerValue.trim() ? headerValue.trim() : undefined;
    if (queryCursor && headerCursor && queryCursor !== headerCursor) {
      return reply.code(400).send({error: "conflicting_stream_cursors"});
    }
    const cursorId = headerCursor ?? queryCursor;
    const turn = await conversationRepo.getTurn(tenant, turnId);
    if (!turn) {
      return reply.code(404).send({error: "turn_not_found"});
    }
    // Resolve the cursor against this Turn before hijacking the response. A
    // single-row lookup keeps reconnect cost independent of the event history.
    const cursor = cursorId
      ? await conversationRepo.getStreamEventById(tenant, turnId, cursorId)
      : null;
    if (cursorId && !cursor) {
      return reply.code(410).send({error: "stream_cursor_expired"});
    }
    const cursorSequence = cursor?.sequence ?? 0;

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
    });

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
    let unsubscribe: (() => void) | undefined;
    let replaying = true;
    let finishing = false;
    let settledDuringReplay = false;
    const bufferedEvents: StreamEventFrame[] = [];

    const finish = (): void => {
      if (closed) return;
      closed = true;
      if (tailTimer) clearInterval(tailTimer);
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = undefined;
      }
      raw.end();
    };
    req.raw.on("close", finish);
    raw.on("close", finish);

    // 事件按 sequence 去重。广播与存量快照可能包含同一事件，且重放期间
    // 收到的广播必须先缓存，避免「读快照 → 订阅总线」之间的竞态窗口。
    let lastSequence = cursorSequence;
    let lastWriteAt = Date.now();
    const writeIfNew = (ev: StreamEventFrame): void => {
      if (closed || ev.sequence <= lastSequence) return;
      writeEventFrame(ev);
      lastSequence = ev.sequence;
      lastWriteAt = Date.now();
    };

    const flushBuffered = (): void => {
      if (bufferedEvents.length === 0) return;
      const pending = bufferedEvents.splice(0).sort((a, b) => a.sequence - b.sequence);
      for (const ev of pending) writeIfNew(ev);
    };

    const attemptSettled = async (): Promise<boolean> => {
      const attempts = await conversationRepo.listTurnAttempts(tenant, turnId);
      const terminal = ["Completed", "Failed", "Interrupted", "Cancelled"];
      return attempts.length > 0 && attempts.every((a) => terminal.includes(a.status));
    };

    let drainPromise: Promise<void> | undefined;
    const drainAndFinish = (): Promise<void> => {
      if (drainPromise) return drainPromise;
      if (closed) return Promise.resolve();
      finishing = true;
      drainPromise = (async () => {
        try {
          // 终态提交与 done/error 事件通常同事务；这里再读一次数据库，兜底
          // 覆盖广播顺序差异，并同时排空查询期间到达的总线事件。
          for (let pass = 0; pass < 2; pass += 1) {
            const remaining = await conversationRepo.getStreamEvents(tenant, turnId, lastSequence);
            for (const ev of remaining) writeIfNew(ev);
            flushBuffered();
            if (remaining.length === 0 && bufferedEvents.length === 0) break;
          }
        } catch {
          // 连接关闭路径不应再向 Fastify 抛出异常。
        } finally {
          finish();
        }
      })();
      return drainPromise;
    };

    // CR-031 活流订阅：先挂载总线，再读取存量快照，彻底消除读快照期间的漏事件窗口。
    unsubscribe = turnStreamHub.subscribe(turnId, {
      onEvent(ev) {
        if (closed) return;
        if (replaying || finishing) {
          bufferedEvents.push(ev);
          return;
        }
        writeIfNew(ev);
      },
      onSettled() {
        if (closed) return;
        if (replaying) {
          settledDuringReplay = true;
          return;
        }
        void drainAndFinish();
      },
    });

    try {
      const persisted = await conversationRepo.getStreamEvents(tenant, turnId, cursorSequence);
      for (const ev of persisted) writeIfNew(ev);
      flushBuffered();
      replaying = false;

      // 终态通知可能在快照读取期间到达；统一走排空路径，避免漏掉尾事件。
      if (closed || settledDuringReplay || (await attemptSettled())) {
        await drainAndFinish();
        return;
      }
    } catch {
      replaying = false;
      finish();
      return;
    }

    // 跨进程/Worker 增量轮询与心跳安全兜底（每 100ms 增量拉取 SQLite 新事件；15s 一次心跳）
    const CROSS_PROCESS_POLL_MS = 100;
    const tailStartedAt = Date.now();
    let polling = false;
    tailTimer = setInterval(() => {
      if (closed || polling) return;
      if (Date.now() - tailStartedAt >= TAIL_MAX_DURATION_MS) {
        finish();
        return;
      }
      polling = true;
      void (async () => {
        try {
          const freshEvents = await conversationRepo.getStreamEvents(tenant, turnId, lastSequence);
          for (const ev of freshEvents) writeIfNew(ev);
          flushBuffered();
          if (await attemptSettled()) {
            await drainAndFinish();
            return;
          }
          if (Date.now() - lastWriteAt >= TAIL_HEARTBEAT_MS) {
            raw.write(`: ping\n\n`);
            lastWriteAt = Date.now();
          }
        } catch {
          // 连接关闭或临时异常不打断轮询
        } finally {
          polling = false;
        }
      })();
    }, CROSS_PROCESS_POLL_MS);
  });

  // POST /v1/turns/{turnId}/cancel — 取消 Turn（AVX-HAR-001 §11.1：Attempt CAS 置 CancelRequested，executor 检查点中止）
  app.post("/v1/turns/:turnId/cancel", async (req, reply) => {
    const { turnId } = req.params as { turnId: string };
    const tenant = resolveLocalContext(req);
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
    activeTurns.get(turnId)?.abort(new Error("turn_cancel_requested"));
    turnStreamHub.publishSettled(turnId, "Cancelled");
    return reply.send({ turnId, status: "Cancelled", cancelled: true });
  });

  // POST /v1/turns/{turnId}/questions/answers — 提交对向用户询问的回答 (UQ-01)
  app.post("/v1/turns/:turnId/questions/answers", async (req, reply) => {
    const { turnId } = req.params as { turnId: string };
    const tenant = resolveLocalContext(req);
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
    const tenant = resolveLocalContext(req);
    const pending = await deps.userQuestionCoordinator.getPending(tenant, turnId);
    if (!pending) {
      return reply.send({ turnId, pending: false, questions: [] });
    }
    return reply.send({ turnId, pending: true, step: pending.step, questions: pending.questions });
  });

  // POST /v1/turns/{turnId}/tool-approvals — 写工具授权决定（阶段 3a：grant / deny；3b：privileged 仅管理员可批准）
  app.post("/v1/turns/:turnId/tool-approvals", async (req, reply) => {
    const { turnId } = req.params as { turnId: string };
    const tenant = resolveLocalContext(req);
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
    const approvalEvent = {
      id: `tev_${Date.now().toString(36)}`,
      turnId,
      sequence: lastSequence + 1,
      eventType: body.decision === "granted" ? "tool_approval_granted" : "tool_approval_denied",
      payloadVersion: 1,
      occurredAt: new Date().toISOString(),
      data: { approvalId: updated.id, decision: updated.state, toolName: updated.toolName },
    };
    await conversationRepo.appendStreamEvent(tenant, approvalEvent);
    turnStreamHub.publishEvent(turnId, approvalEvent);
    return reply.send({ approvalId: updated.id, state: updated.state });
  });

  // 阶段 5c：子任务审计（subagent_runs；租户隔离；返回父 Turn 委托的全部子任务运行记录）
  app.get("/v1/turns/:turnId/subagents", async (req, reply) => {
    const { turnId } = req.params as { turnId: string };
    const tenant = resolveLocalContext(req);
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
    const tenant = resolveLocalContext(req);
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
    const tenant = resolveLocalContext(req);
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
    const tenant = resolveLocalContext(req);

    const deleted = await conversationRepo.softDeleteMessage(tenant, messageId);
    if (!deleted) {
      return reply.code(404).send({ error: "Message not found or already deleted" });
    }

    return reply.send({ messageId, deletedAt: deleted.deletedAt });
  });

  // GET /v1/messages/:messageId/delete-impact — 删除影响预览（FR-CONV-005）
  app.get("/v1/messages/:messageId/delete-impact", async (req, reply) => {
    const { messageId } = req.params as { messageId: string };
    const tenant = resolveLocalContext(req);

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
    const tenant = resolveLocalContext(req);

    const restored = await conversationRepo.restoreMessage(tenant, messageId);
    if (!restored) {
      return reply.code(404).send({ error: "Message not found" });
    }

    return reply.send(restored);
  });

  // GET /v1/messages/:messageId/versions — 消息版本历史（FR-CONV-004）
  app.get("/v1/messages/:messageId/versions", async (req, reply) => {
    const { messageId } = req.params as { messageId: string };
    const tenant = resolveLocalContext(req);

    const versions = await conversationRepo.listMessageVersions(tenant, messageId);
    return reply.send({ messageId, versions });
  });
}
