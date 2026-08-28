/**
 * Aervox｜思隅 @aervox/api — 向用户询问会话协调器 (UserQuestionCoordinator)
 *
 * 维护挂起的提问请求（Promise Resolvers 与超时定时器）：
 * 当模型调用 ask_user_question 时向客户端下发 SSE 流事件并挂起，
 * 当客户端 POST /v1/turns/:turnId/questions/answers 时唤醒并返回 answers。
 *
 * 缺陷 C（挂起会话持久化）：挂起状态除内存外写入 pending_user_questions 表，
 * 使「提问已下发但 Loop 进程崩溃/重启」后仍可查询与作答：
 * - submitAnswers 在内存态丢失时走持久化恢复路径（写 user_question_answered 留痕 + 接受答案），
 *   不再因内存态丢失而 409 悬挂；
 * - 超时唯一真源为持久化 expiresAt（createdAt + timeoutMs），崩溃后过期判定仍正确；
 * - getPending 在内存态丢失时回退持久化查询，支持断线恢复展示既有问题。
 */
import type {
  AskUserQuestionAnswerItem,
  AskUserQuestionItem,
  SubmitQuestionAnswersResponse,
} from "@aervox/contracts";
import type {
  AskUserQuestionPortRequest,
  AskUserQuestionPortResult,
  UserQuestionPort,
} from "@aervox/agent-loop";
import type {
  IUserQuestionRepository,
  SqliteConversationRepository,
  TenantContext,
} from "@aervox/database";

interface PendingQuestionSession {
  turnId: string;
  attemptId: string;
  step: number;
  tenant: TenantContext;
  questions: AskUserQuestionItem[];
  timeoutMs: number;
  resolve: (result: AskUserQuestionPortResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  createdAt: number;
}

export class UserQuestionCoordinator {
  private pendingByTurn = new Map<string, PendingQuestionSession>();

  constructor(
    private readonly conversationRepo: SqliteConversationRepository,
    /** 持久化挂起会话（缺陷 C）；缺省不启用持久化，保持既有内存行为 */
    private readonly pendingRepo?: IUserQuestionRepository,
  ) {}

  /** 创建与特定租户绑定的 UserQuestionPort 实例注入 Agent Loop */
  createPort(tenant: TenantContext): UserQuestionPort {
    return {
      ask: (req: AskUserQuestionPortRequest) => this.handleAsk(tenant, req),
    };
  }

  /**
   * 获取当前挂起的提问（断线恢复或查询用）。
   * 内存态存在优先返回；内存态丢失（进程重启）时回退持久化，
   * 仅当未超时且事件流尚无已作答记录时视为仍挂起。
   */
  async getPending(
    tenant: TenantContext,
    turnId: string,
  ): Promise<{ turnId: string; questions: AskUserQuestionItem[]; step: number } | undefined> {
    const session = this.pendingByTurn.get(turnId);
    if (session) {
      return {
        turnId: session.turnId,
        questions: session.questions,
        step: session.step,
      };
    }
    if (!this.pendingRepo) return undefined;

    const stored = await this.pendingRepo.getPending(tenant, turnId);
    if (!stored) return undefined;
    if (stored.expiresAt <= new Date().toISOString()) {
      // 过期挂起回收（进程崩溃后 timer 丢失，这里按持久化 expiresAt 判定）
      await this.pendingRepo.deletePending(tenant, turnId).catch(() => undefined);
      return undefined;
    }
    if (await this.hasAnswered(tenant, turnId)) return undefined;

    return {
      turnId: stored.turnId,
      questions: stored.questions as AskUserQuestionItem[],
      step: stored.step,
    };
  }

  /** 处理 Loop 侧的提问请求 */
  private async handleAsk(
    tenant: TenantContext,
    req: AskUserQuestionPortRequest,
  ): Promise<AskUserQuestionPortResult> {
    const { turnId, attemptId, step, questions, timeoutMs = 60000 } = req;

    // 1. 写入 user_question_required 流事件（持久化至 SQLite 供 SSE 重放与前端消费）
    const eventId = `ev_uq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const events = await this.conversationRepo.getStreamEvents(tenant, turnId, 0);
    const sequence = events.length + 1;

    await this.conversationRepo.appendStreamEvent(tenant, {
      id: eventId,
      turnId,
      sequence,
      eventType: "user_question_required",
      data: {
        turnId,
        step,
        questions,
        timeoutMs,
      },
    });

    // 1.5 持久化挂起会话（缺陷 C）：超时唯一真源 = createdAt + timeoutMs
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + timeoutMs).toISOString();
    await this.pendingRepo?.upsertPending(tenant, {
      turnId,
      attemptId,
      step,
      questions,
      timeoutMs,
      createdAt,
      expiresAt,
    });

    // 2. 挂起等待客户端回答
    return new Promise<AskUserQuestionPortResult>((resolve, reject) => {
      // 冲突保护：如果该 Turn 已有挂起问题，先清理
      if (this.pendingByTurn.has(turnId)) {
        const old = this.pendingByTurn.get(turnId)!;
        clearTimeout(old.timer);
        old.reject(new Error("SUPERSEDED_BY_NEW_QUESTION"));
        this.pendingByTurn.delete(turnId);
      }

      // 缺陷 D：宿主工具超时/取消信号 → 立即终止等待（清理内存挂起 + 持久化），
      // 而不是让 ask 继续挂到自然超时——「超时即终止」语义真正生效。
      const cancelPending = (err: Error): void => {
        const current = this.pendingByTurn.get(turnId);
        if (current) {
          clearTimeout(current.timer);
          this.pendingByTurn.delete(turnId);
        }
        void this.pendingRepo?.deletePending(tenant, turnId).catch(() => undefined);
        reject(err);
      };
      const onAbort = (): void => {
        const reason = req.signal?.reason;
        cancelPending(
          reason instanceof Error
            ? new Error(`USER_QUESTION_CANCELLED: ${reason.message}`)
            : new Error("USER_QUESTION_CANCELLED"),
        );
      };
      if (req.signal) {
        if (req.signal.aborted) {
          onAbort();
          return;
        }
        req.signal.addEventListener("abort", onAbort, { once: true });
      }

      const timer = setTimeout(async () => {
        this.pendingByTurn.delete(turnId);
        req.signal?.removeEventListener("abort", onAbort);
        // 超时兜底：清掉持久化挂起（即使这里崩溃，恢复路径也会按 expiresAt 判定超时）
        await this.pendingRepo?.deletePending(tenant, turnId).catch(() => undefined);
        // 超时兜底：如果首个问题有 Recommended 选项则自动选用，否则抛出超时错误
        const defaultAnswers: AskUserQuestionAnswerItem[] = questions.map((q) => {
          const recommended = q.options?.find((opt) => opt.label.includes("(Recommended)"));
          return {
            id: q.id,
            selected: recommended ? [recommended.label] : [],
          };
        });

        // 若全部问题都有选项或推荐则放行，否则超时报错
        const canDefault = questions.every((q) => (q.options?.length ?? 0) > 0);
        if (canDefault && defaultAnswers.length > 0) {
          resolve({ answers: defaultAnswers });
        } else {
          reject(new Error(`QUESTION_TIMEOUT: User did not answer within ${timeoutMs}ms`));
        }
      }, timeoutMs);

      this.pendingByTurn.set(turnId, {
        turnId,
        attemptId,
        step,
        tenant,
        questions,
        timeoutMs,
        resolve,
        reject,
        timer,
        createdAt: Date.now(),
      });
    });
  }

  /** 客户端提交回答 */
  async submitAnswers(
    tenant: TenantContext,
    turnId: string,
    answers: AskUserQuestionAnswerItem[],
  ): Promise<SubmitQuestionAnswersResponse> {
    const session = this.pendingByTurn.get(turnId);
    if (!session) {
      // 内存态丢失（进程重启/多实例）→ 走持久化恢复路径（缺陷 C）
      return this.submitAnswersFromPersistence(tenant, turnId, answers);
    }

    clearTimeout(session.timer);
    this.pendingByTurn.delete(turnId);

    // 1. 写入 user_question_answered 流事件留痕
    await this.writeAnsweredEvent(tenant, turnId, answers);

    // 2. 清理持久化挂起（避免残留；不阻塞回答主流程）
    await this.pendingRepo?.deletePending(tenant, turnId).catch(() => undefined);

    // 3. 唤醒挂起的 Loop
    session.resolve({ answers });

    return {
      turnId,
      accepted: true,
      answers,
    };
  }

  /** 内存态丢失时：按持久化挂起会话接受回答（幂等、过期降级、留痕） */
  private async submitAnswersFromPersistence(
    tenant: TenantContext,
    turnId: string,
    answers: AskUserQuestionAnswerItem[],
  ): Promise<SubmitQuestionAnswersResponse> {
    if (!this.pendingRepo) {
      throw new Error("NO_PENDING_QUESTION: Turn is not currently waiting for user questions or timed out");
    }

    // 幂等：事件流已有 answered 记录（如重复提交）→ 直接返回 accepted，不重复写事件
    if (await this.hasAnswered(tenant, turnId)) {
      return { turnId, accepted: true, answers };
    }

    const stored = await this.pendingRepo.getPending(tenant, turnId);
    if (!stored) {
      throw new Error("NO_PENDING_QUESTION: Turn is not currently waiting for user questions or timed out");
    }
    // 超时判定以持久化 expiresAt 为唯一真源（进程重启后 timer 已丢失）
    if (stored.expiresAt <= new Date().toISOString()) {
      await this.pendingRepo.deletePending(tenant, turnId).catch(() => undefined);
      throw new Error(
        `NO_PENDING_QUESTION: Question session timed out at ${stored.expiresAt}`,
      );
    }

    // 留痕 + 清理持久化（Loop 进程已随崩溃消失，答案写入事件流供未来 resume/重放消费）
    await this.writeAnsweredEvent(tenant, turnId, answers);
    await this.pendingRepo.deletePending(tenant, turnId).catch(() => undefined);

    return {
      turnId,
      accepted: true,
      answers,
    };
  }

  private async hasAnswered(tenant: TenantContext, turnId: string): Promise<boolean> {
    const events = await this.conversationRepo.getStreamEvents(tenant, turnId, 0);
    return events.some((e) => e.eventType === "user_question_answered");
  }

  /** 写入 user_question_answered 事件（sequence 在事件流末尾续接） */
  private async writeAnsweredEvent(
    tenant: TenantContext,
    turnId: string,
    answers: AskUserQuestionAnswerItem[],
  ): Promise<void> {
    const eventId = `ev_ua_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const events = await this.conversationRepo.getStreamEvents(tenant, turnId, 0);
    const sequence = events.length + 1;

    await this.conversationRepo.appendStreamEvent(tenant, {
      id: eventId,
      turnId,
      sequence,
      eventType: "user_question_answered",
      data: {
        turnId,
        answers,
      },
    });
  }
}