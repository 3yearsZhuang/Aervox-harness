/**
 * Aervox｜思隅 @aervox/api — 会话/流式协议路由
 *
 * 规则依据：docs/reference/STREAMING_PROTOCOL.md + @aervox/contracts + AVX-HAR-001（阶段 1）。
 * 迁移自原单文件 index.ts，并补充 Message 身份写链路；SSE 事件来自持久 turn_stream_events，
 * Turn 创建后由 Agent Loop（Replay Provider）执行并写事件。
 */
import type { FastifyInstance } from "fastify";
import {
  turnDiagnosticsApi,
  createTurnRequestSchema,
  editMessageSchema,
  submitQuestionAnswersRequestSchema,
  createSessionRequestSchema,
  renameSessionRequestSchema,
} from "@aervox/contracts";
import { TurnIntentConflictError } from "@aervox/repositories";
import type { ConversationCommandPort, ConversationQueryPort } from "./application.js";
import { ConversationCommandError } from "./approval-command.js";
import { registerContractRoute } from "../../../shared/contract-route.js";
import { resolveLocalContext } from "../../../shared/local-context.js";
import { turnStreamHub } from "./stream-hub.js";
import { encodeSseEvent, writeSseFrame, SseWriteError } from "./sse-writer.js";

let seq = 0;
const nextTurnId = (): string => `turn_${Date.now().toString(36)}_${(++seq).toString(36)}`;

/** HTTP exposes supported application use cases and bounded observation projections only. */
export interface ConversationHttpPort {
  commands: Pick<ConversationCommandPort, "ensureSession" | "createSession" | "renameSession" | "deleteSession" | "createTurn" |
    "cancelTurn" | "answerQuestions" | "approve" | "createMessage" | "editMessage" | "deleteMessage" | "restoreMessage">;
  queries: Pick<ConversationQueryPort, "getTurnDiagnostics" | "listSessions" | "getTurn" | "getStreamEventById" |
    "getStreamEventHighWater" | "getStreamReplayState" | "getStreamEventsPage" | "pendingQuestions" | "subagents" |
    "workflows" | "messageDeleteImpact" | "listMessageVersions">;
}

export function registerConversationRoutes(
  app: FastifyInstance,
  application: ConversationHttpPort,
  deps: { apiRegistry?: import("@aervox/contracts").PluginApiRegistry; observability?: import("@aervox/observability").Observability } = {},
): void {
  const { commands, queries } = application;
  // Domain errors stay in the application; this hook only maps their HTTP representation.
  app.addHook("onError", async (_request, reply, error) => {
    if (error instanceof ConversationCommandError) reply.code(error.statusCode);
  });
  const activeStreams = new Set<() => void>();
  let hostClosing = false;
  // preClose runs before server.close waits for open SSE sockets (Fastify 5).
  app.addHook("preClose", async () => {
    hostClosing = true;
    for (const close of activeStreams) close();
  });
  registerContractRoute(app, turnDiagnosticsApi.get, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const { turnId } = req.params as { turnId: string };
    const { attemptId } = req.query as { attemptId?: string };
    const diagnostics = await queries.getTurnDiagnostics(resolveLocalContext(req), turnId, attemptId);
    if (!diagnostics) return reply.code(404).send({ code: "TURN_OR_ATTEMPT_NOT_FOUND", message: "Turn or Attempt not found" });
    return diagnostics;
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
    const items = await queries.listSessions(tenant, {
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
      session = await commands.ensureSession(tenant, parsed.data.id, title, parsed.data.projectId);
    } else {
      session = await commands.createSession(tenant, title, { projectId: parsed.data.projectId });
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
    const updated = await commands.renameSession(tenant, sessionId, {
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
    const deleted = await commands.deleteSession(tenant, sessionId);
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

    const turnId = nextTurnId();
    const messageId = `msg_${Date.now().toString(36)}_${(++seq).toString(36)}`;
    const attemptId = `atp_${turnId}`;
    let accepted: Awaited<ReturnType<typeof commands.createTurn>>;
    try {
      accepted = await commands.createTurn(tenant, {
        metadata: parsed.data.metadata, toolApprovalMode: parsed.data.toolApprovalMode,
        turnId, sessionId, idempotencyKey, attemptId, references: parsed.data.references,
        message: { id: messageId, ...parsed.data.message },
      });
    } catch (error) {
      if (error instanceof TurnIntentConflictError) return reply.code(409).send({
        code: "IDEMPOTENCY_KEY_REUSED", reason: error.reason, retryable: false,
        message: error.reason === "intent_unavailable" ? "The original Turn intent cannot be verified" : "Idempotency key belongs to a different Turn intent",
      });
      throw error;
    }
    if (!accepted.created) {
      return reply.code(200).send({
        turnId: accepted.turn.id, status: accepted.turn.status,
        eventsUrl: `/v1/turns/${accepted.turn.id}/events`, cancelUrl: `/v1/turns/${accepted.turn.id}/cancel`,
      });
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
    const turn = await queries.getTurn(tenant, turnId);
    if (!turn) {
      return reply.code(404).send({error: "turn_not_found"});
    }
    // Resolve the cursor against this Turn before hijacking the response. A
    // single-row lookup keeps reconnect cost independent of the event history.
    const cursor = cursorId
      ? await queries.getStreamEventById(tenant, turnId, cursorId)
      : null;
    if (cursorId && !cursor) {
      return reply.code(410).send({error: "stream_cursor_expired"});
    }
    const cursorSequence = cursor?.sequence ?? 0;

    // Reads above can finish after preClose already swept active connections.
    // Check before hijack/registration, with no intervening await.
    if (hostClosing) return reply.code(503).send({ error: "host_closed" });
    if (req.raw.aborted || reply.raw.destroyed) return;

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
    });

    const TAIL_HEARTBEAT_MS = 15_000;
    const TAIL_MAX_DURATION_MS = 10 * 60_000;
    const CROSS_PROCESS_POLL_MS = 100;
    const connection = new AbortController();
    let closed = false;
    let ready = false;
    let pumping = false;
    let wakeRequested = false;
    let lastSequence = cursorSequence;
    let lastWriteAt = Date.now();
    let pages = 0;
    let oversizedEvents = 0;
    let backpressureWaits = 0;
    let peakQueuedBytes = 0;
    let writableHighWaterMark = 0;
    let tailTimer: ReturnType<typeof setInterval> | undefined;
    let durationTimer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;

    const finish = (destroy = false, reason = "sse_closed"): void => {
      if (closed) return;
      closed = true;
      connection.abort();
      if (tailTimer) clearInterval(tailTimer);
      if (durationTimer) clearTimeout(durationTimer);
      unsubscribe?.();
      unsubscribe = undefined;
      activeStreams.delete(shutdown);
      req.raw.off("aborted", disconnected);
      raw.off("close", disconnected);
      raw.off("error", disconnected);
      if (backpressureWaits || oversizedEvents) {
        deps.observability?.log.info({
          event: "sse.connection.closed",
          message: "SSE connection closed",
          fields: { reason, pages, oversizedEvents, backpressureWaits, peakQueuedBytes, writableHighWaterMark },
        });
      }
      // A timed-out/closed socket must not retain queued data while shutdown waits.
      if (destroy) raw.destroy();
      else raw.end();
    };
    const disconnected = (): void => finish(true);
    const shutdown = (): void => finish(true, "sse_host_closed");
    activeStreams.add(shutdown);
    req.raw.on("aborted", disconnected);
    raw.on("close", disconnected);
    raw.on("error", disconnected);
    durationTimer = setTimeout(() => finish(true, "sse_duration_limit"), TAIL_MAX_DURATION_MS);
    durationTimer.unref();

    const write = async (frame: string): Promise<void> => {
      await writeSseFrame(raw, frame, {
        signal: connection.signal,
        onBackpressure(queuedBytes, highWaterMark) {
          backpressureWaits += 1;
          peakQueuedBytes = Math.max(peakQueuedBytes, queuedBytes);
          writableHighWaterMark = highWaterMark;
        },
      });
      lastWriteAt = Date.now();
    };
    const replayThrough = async (upperBound: number): Promise<void> => {
      while (!closed && lastSequence < upperBound) {
        const page = await queries.getStreamEventsPage(tenant, turnId, {
          afterSequence: lastSequence, throughSequence: upperBound,
        });
        pages += 1;
        if (closed) return;
        if (page.events.length === 0) throw new Error("sse_replay_page_empty");
        if (page.oversizedEvent) oversizedEvents += 1;
        for (const ev of page.events) {
          if (closed) return;
          if (ev.sequence <= lastSequence) continue;
          await write(encodeSseEvent(ev, deps.apiRegistry));
          lastSequence = ev.sequence;
        }
        // No next page is queried while any frame is waiting for socket drain.
      }
    };
    const failConnection = (error: unknown): void => {
      finish(true, error instanceof SseWriteError ? error.code : "sse_read_failed");
    };

    // Exactly one query/writer owner. Bus traffic retains only a coalesced wake
    // bit, never payloads; sequence and content always come from durable SQLite.
    const pump = async (): Promise<void> => {
      if (closed || !ready || pumping) return;
      pumping = true;
      try {
        do {
          wakeRequested = false;
          const state = await queries.getStreamReplayState(tenant, turnId);
          await replayThrough(state.highWaterSequence);
          if (closed) return;
          if (state.settled) {
            // Refresh both facts together after replay. A continuation or terminal
            // commit during replay must not be paired with an older status/watermark.
            const latest = await queries.getStreamReplayState(tenant, turnId);
            if (closed) return;
            if (latest.highWaterSequence > lastSequence) {
              wakeRequested = true;
            } else if (latest.settled && !wakeRequested) {
              finish();
              return;
            }
          }
          if (!closed && Date.now() - lastWriteAt >= TAIL_HEARTBEAT_MS) await write(": ping\n\n");
        } while (wakeRequested && !closed);
      } catch (error) {
        failConnection(error);
      } finally {
        pumping = false;
      }
    };
    const wake = (): void => {
      if (closed) return;
      wakeRequested = true;
      void pump();
    };
    // Subscribe before capturing the replay snapshot. Events arriving during
    // replay are subsequently fetched in order, even if bus delivery is reordered.
    unsubscribe = turnStreamHub.subscribe(turnId, { onEvent: wake, onSettled: wake });
    tailTimer = setInterval(wake, CROSS_PROCESS_POLL_MS);
    tailTimer.unref();
    try {
      await replayThrough(await queries.getStreamEventHighWater(tenant, turnId));
      ready = true;
      await pump();
    } catch (error) {
      failConnection(error);
    }
  });

  // POST /v1/turns/{turnId}/cancel — 取消 Turn（AVX-HAR-001 §11.1：Attempt CAS 置 CancelRequested，executor 检查点中止）
  app.post("/v1/turns/:turnId/cancel", async (req, reply) => {
    const { turnId } = req.params as { turnId: string };
    const tenant = resolveLocalContext(req);
    try { return reply.send(await commands.cancelTurn(tenant, turnId)); }
    catch (error) { if (error instanceof ConversationCommandError) return reply.code(error.statusCode).send(error.body); throw error; }

  });

  // POST /v1/turns/{turnId}/questions/answers — 提交对向用户询问的回答 (UQ-01)
  app.post("/v1/turns/:turnId/questions/answers", async (req, reply) => {
    const { turnId } = req.params as { turnId: string };
    const tenant = resolveLocalContext(req);
    const parsed = submitQuestionAnswersRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_request",
        details: parsed.error.issues,
      });
    }
    try {
      const res = await commands.answerQuestions(
        tenant,
        turnId,
        parsed.data.answers,
      );
      return reply.send(res);
    } catch (err) {
      if (err instanceof ConversationCommandError) return reply.code(err.statusCode).send(err.body);
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
    const tenant = resolveLocalContext(req);
    let pending: Awaited<ReturnType<typeof queries.pendingQuestions>>;
    try { pending = await queries.pendingQuestions(tenant, turnId); }
    catch (error) { if (error instanceof ConversationCommandError) return reply.code(error.statusCode).send(error.body); throw error; }
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
    try { return reply.send(await commands.approve(tenant, turnId, {
      approvalId: body.approvalId, decision: body.decision,
      adminId: req.headers["x-admin-user-id"] as string | undefined,
    })); } catch (error) {
      if (error instanceof ConversationCommandError) return reply.code(error.statusCode).send(error.body);
      throw error;
    }

  });

  // 阶段 5c：子任务审计（subagent_runs；租户隔离；返回父 Turn 委托的全部子任务运行记录）
  app.get("/v1/turns/:turnId/subagents", async (req, reply) => {
    const { turnId } = req.params as { turnId: string };
    const tenant = resolveLocalContext(req);
    let runs: Awaited<ReturnType<typeof queries.subagents>>;
    try { runs = await queries.subagents(tenant, turnId); }
    catch (error) { if (error instanceof ConversationCommandError) return reply.code(error.statusCode).send(error.body); throw error; }
    return reply.send({ turnId, runs });
  });

  // 阶段 5c：Workflow 注册清单（元数据；执行经 `workflow_run` 工具，不在此直接触发）
  app.get("/v1/workflows", async (_req, reply) => {
    const workflows = queries.workflows();
    return reply.send({ workflows });
  });

  // POST /v1/messages — 创建消息身份（身份与版本分离的写链路）
  app.post("/v1/messages", async (req, reply) => {
    const tenant = resolveLocalContext(req);
    const body = (req.body ?? {}) as { sessionId?: string; role?: string; label?: string };
    if (!body.sessionId || !body.role) {
      return reply.code(400).send({ error: "sessionId and role are required" });
    }
    const message = await commands.createMessage(tenant, {
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

    const result = await commands.editMessage(
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

    const deleted = await commands.deleteMessage(tenant, messageId);
    if (!deleted) {
      return reply.code(404).send({ error: "Message not found or already deleted" });
    }

    return reply.send({ messageId, deletedAt: deleted.deletedAt });
  });

  // GET /v1/messages/:messageId/delete-impact — 删除影响预览（FR-CONV-005）
  app.get("/v1/messages/:messageId/delete-impact", async (req, reply) => {
    const { messageId } = req.params as { messageId: string };
    const tenant = resolveLocalContext(req);

    const impact = await queries.messageDeleteImpact(tenant, messageId);
    if (!impact) return reply.code(404).send({ error: "Message not found" });
    return reply.send(impact);

  });

  // POST /v1/messages/:messageId/restore — 恢复已删除消息
  app.post("/v1/messages/:messageId/restore", async (req, reply) => {
    const { messageId } = req.params as { messageId: string };
    const tenant = resolveLocalContext(req);

    const restored = await commands.restoreMessage(tenant, messageId);
    if (!restored) {
      return reply.code(404).send({ error: "Message not found" });
    }

    return reply.send(restored);
  });

  // GET /v1/messages/:messageId/versions — 消息版本历史（FR-CONV-004）
  app.get("/v1/messages/:messageId/versions", async (req, reply) => {
    const { messageId } = req.params as { messageId: string };
    const tenant = resolveLocalContext(req);

    const versions = await queries.listMessageVersions(tenant, messageId);
    return reply.send({ messageId, versions });
  });
}
