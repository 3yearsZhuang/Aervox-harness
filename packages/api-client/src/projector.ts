/**
 * Aervox｜思隅 @aervox/api-client — 客户端安全投影与防乱序/防复活状态机 (BTD-06)
 *
 * 核心保证（规范依据：CR-056 §5.7 & aervox_core_evolution_plan §4.2）：
 * 1. 唯一性与保序性：单调递增验证 sequence，丢弃 <= lastSequence 的重复或乱序迟到事件；
 * 2. 身份隔离：严格匹配 expectedTurnId，拒绝跨会话或非本回合的迟到事件；
 * 3. 终态不可逆：一旦接收到 done 或 error 终态，状态机终结，后续任何暂态事件（如网络迟到的 delta）绝对无法复活旧状态；
 * 4. 统一投影规则：Web（Fetch/SSE）与 Electron（IPC Bridge）共享完全一致的投影与过滤行为。
 */

import type {
  PetCommand,
  ToolApprovalRequiredEventData,
  TurnStreamEvent,
  UserQuestionRequiredEventData,
} from '@aervox/contracts';
import type { TurnCallbacks } from './transport.js';

export type DropReason = 'wrong_turn' | 'out_of_order' | 'duplicate' | 'post_terminal';

/**
 * 内核自有事件类型（CR-060）。
 *
 * 这些事件已由本投影器的显式分支消费，或由宿主自身路径（消息落库、工具执行账本、
 * 追问答复）处理；它们**不得**顺带进入通用插件出口——否则插件会拿到内核事件的
 * 原始载荷，与"插件只订阅自己登记的事件类型"相矛盾。
 */
const KERNEL_EVENT_TYPES: ReadonlySet<string> = new Set([
  'message',
  'redacted',
  'user_question_answered',
  'tool_request',
  'tool_result',
]);

export interface TurnProjectorOptions {
  /** 期望的 Turn ID；设置后若收到其它 turnId 的事件将直接丢弃 */
  expectedTurnId?: string;
  /** 初始 sequence 水位（断线重连恢复时传入最后确认的 sequence；缺省为 0） */
  initialSequence?: number;
  /** 事件被丢弃时的可观测性钩子 */
  onDropped?: (reason: DropReason, event: unknown) => void;
}

export class TurnStreamProjector {
  private lastSequence: number;
  private isFinalized = false;
  private expectedTurnId?: string;
  private onDropped?: (reason: DropReason, event: unknown) => void;

  constructor(options?: TurnProjectorOptions) {
    this.lastSequence = options?.initialSequence ?? 0;
    this.expectedTurnId = options?.expectedTurnId;
    this.onDropped = options?.onDropped;
  }

  public get currentSequence(): number {
    return this.lastSequence;
  }

  public get finalized(): boolean {
    return this.isFinalized;
  }

  public get turnId(): string | undefined {
    return this.expectedTurnId;
  }

  public setExpectedTurnId(turnId: string): void {
    if (!this.expectedTurnId) {
      this.expectedTurnId = turnId;
    }
  }

  /**
   * 接收原始流式事件，执行投影过滤与状态机防御，并在安全通过时分发给回调函数。
   * @returns true 表示事件安全投递，false 表示事件被防御性拦截并丢弃。
   */
  public project(
    event: TurnStreamEvent | { turnId?: string; sequence?: number; eventType: string; data?: unknown },
    callbacks: TurnCallbacks,
  ): boolean {
    if (!event || typeof event !== 'object') {
      return false;
    }

    // 1. 身份校验：丢弃跨 Turn / 迟到旧 Turn 事件
    if (this.expectedTurnId && event.turnId && event.turnId !== this.expectedTurnId) {
      this.onDropped?.('wrong_turn', event);
      return false;
    }
    if (!this.expectedTurnId && event.turnId) {
      this.expectedTurnId = event.turnId;
    }

    // 2. 终态防复活检查：若当前 Turn 已终态，绝对丢弃任何迟到的暂态事件
    if (this.isFinalized) {
      this.onDropped?.('post_terminal', event);
      return false;
    }

    // 3. 单调性与乱序校验：丢弃 sequence <= lastSequence 的事件
    if (typeof event.sequence === 'number') {
      if (event.sequence <= this.lastSequence) {
        this.onDropped?.(event.sequence === this.lastSequence ? 'duplicate' : 'out_of_order', event);
        return false;
      }
      this.lastSequence = event.sequence;
    }

    // 4. 安全分发
    const eventType = event.eventType;
    const data = event.data;

    if (eventType === 'delta') {
      const text = (data as { text?: string })?.text;
      if (text) callbacks.onDelta(text);
    } else if (eventType === 'reasoning_delta') {
      const text = (data as { text?: string })?.text;
      if (text) callbacks.onReasoning?.(text);
    } else if (eventType === 'done') {
      this.isFinalized = true;
      callbacks.onDone();
    } else if (eventType === 'error') {
      this.isFinalized = true;
      const message = (data as { message?: string })?.message ?? 'Turn 出错';
      callbacks.onError?.(new Error(message));
    } else if (eventType === 'emote') {
      callbacks.onEmote?.(data as PetCommand);
    } else if (eventType === 'user_question_required') {
      callbacks.onUserQuestion?.(data as UserQuestionRequiredEventData);
    } else if (eventType === 'tool_approval_required') {
      callbacks.onToolApproval?.({
        ...(data as ToolApprovalRequiredEventData),
        turnId: event.turnId ?? this.expectedTurnId ?? '',
      });
    } else if (!KERNEL_EVENT_TYPES.has(eventType)) {
      // CR-060：只有插件自有事件类型进入通用插件出口（内核事件见 KERNEL_EVENT_TYPES）
      callbacks.onPluginEvent?.(eventType, data);
    }

    return true;
  }
}
