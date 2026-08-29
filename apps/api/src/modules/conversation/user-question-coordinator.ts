/**
 * Aervox｜思隅 @aervox/api — 向用户询问会话协调器 (UserQuestionCoordinator)
 *
 * 维护内存中挂起的提问请求（Promise Resolvers 与超时定时器），
 * 当模型调用 ask_user_question 时向客户端下发 SSE 流事件并挂起，
 * 当客户端 POST /v1/turns/:turnId/questions/answers 时唤醒并返回 answers。
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
import type { SqliteConversationRepository, TenantContext } from "@aervox/database";

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

  constructor(private readonly conversationRepo: SqliteConversationRepository) {}

  /** 创建与特定租户绑定的 UserQuestionPort 实例注入 Agent Loop */
  createPort(tenant: TenantContext): UserQuestionPort {
    return {
      ask: (req: AskUserQuestionPortRequest) => this.handleAsk(tenant, req),
    };
  }

  /** 获取当前挂起的提问（断线恢复或查询用） */
  getPending(turnId: string): { turnId: string; questions: AskUserQuestionItem[]; step: number } | undefined {
    const session = this.pendingByTurn.get(turnId);
    if (!session) return undefined;
    return {
      turnId: session.turnId,
      questions: session.questions,
      step: session.step,
    };
  }

  /** 处理 Loop 侧的提问请求 */
  private async handleAsk(
    tenant: TenantContext,
    req: AskUserQuestionPortRequest,
  ): Promise<AskUserQuestionPortResult> {
    const { turnId, attemptId, step, questions, timeoutMs = 60000 } = req;

    // 1. 写入 user_question_required 流事件（持久化至 SQLite 供 SSE 重放与前端消费）
    //    序号由仓储原子分配——与执行器的本地计数器并发追加不再冲突
    const eventId = `ev_uq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

    await this.conversationRepo.appendStreamEvent(tenant, {
      id: eventId,
      turnId,
      eventType: "user_question_required",
      data: {
        turnId,
        step,
        questions,
        timeoutMs,
      },
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

      const timer = setTimeout(async () => {
        this.pendingByTurn.delete(turnId);
        // 超时兜底：如果首个问题有 Recommended 选项则自动选用，否则抛出超时错误
        const defaultAnswers: AskUserQuestionAnswerItem[] = questions.map((q) => {
          const recommended = q.options?.find((opt) => opt.label.includes("(Recommended)"));
          return {
            id: q.id,
            selected: recommended ? [recommended.label] : [],
          };
        });

        // 若全部问题都有选项或推荐则放行，否则超时报错。
        // 错误信息面向模型：明确指示不要重复提问，避免"超时→再问→再超时"的 60s×N 循环。
        const canDefault = questions.every((q) => (q.options?.length ?? 0) > 0);
        if (canDefault && defaultAnswers.length > 0) {
          resolve({ answers: defaultAnswers });
        } else {
          reject(
            new Error(
              `QUESTION_TIMEOUT: 用户未在 ${timeoutMs}ms 内回答（客户端在回合结束后才能看到问题）。` +
                `请勿再次提问或等待：基于现有信息继续完成任务，或礼貌说明稍后可重新发起。`,
            ),
          );
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
      throw new Error("NO_PENDING_QUESTION: Turn is not currently waiting for user questions or timed out");
    }

    clearTimeout(session.timer);
    this.pendingByTurn.delete(turnId);

    // 1. 写入 user_question_answered 流事件留痕（序号仓储原子分配）
    const eventId = `ev_ua_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

    await this.conversationRepo.appendStreamEvent(tenant, {
      id: eventId,
      turnId,
      eventType: "user_question_answered",
      data: {
        turnId,
        answers,
      },
    });

    // 2. 唤醒挂起的 Loop
    session.resolve({ answers });

    return {
      turnId,
      accepted: true,
      answers,
    };
  }
}
