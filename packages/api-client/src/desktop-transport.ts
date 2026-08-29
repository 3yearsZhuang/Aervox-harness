/**
 * Aervox｜思隅 @aervox/api-client — 桌面端（Electron IPC）传输实现
 *
 * 包装 preload 暴露的 window.fairyDesktop（apiRequest / streamTurn），
 * 供桌面 renderer 在入口 configureAervoxClient({ transport: desktopTransport }) 注入。
 * 无桥环境（如浏览器预览）下由调用方改用 fetchTransport，本实现不做隐式降级。
 */

import type {
  AskUserQuestionAnswerItem,
  PetCommand,
  ToolApprovalMode,
  ToolApprovalRequiredEventData,
  TurnAttachmentRef,
  TurnStreamEvent,
  UserQuestionRequiredEventData,
} from '@aervox/contracts';
import type {
  AervoxTransport,
  AttachmentUploadInput,
  StreamTurnOptions,
  TurnCallbacks,
  UploadedAttachment,
} from './transport';

declare global {
  interface Window {
    fairyDesktop?: {
      apiRequest: <T = unknown>(
        method: string,
        path: string,
        body?: unknown,
        headers?: Record<string, string>,
      ) => Promise<{ status: number; ok: boolean; json: T | null; text: string }>;
      streamTurn: (
        content: string,
        options: {
          toolApprovalMode: ToolApprovalMode;
          attachments?: TurnAttachmentRef[];
          /** CR-027：渲染层生成的请求 ID，供 cancelTurn 定位主进程在途请求 */
          requestId?: string;
        },
        callback: (message: unknown) => void,
      ) => () => void;
      /** CR-027：中止主进程仍在等待/消费的上游 Turn 请求（超时或 UI 主动放弃时调用） */
      cancelTurn?: (requestId: string) => void;
      /** 打开系统「选择文件夹」对话框，返回选中目录绝对路径；取消返回 null（CR-011 阶段 3） */
      pickDirectory?: () => Promise<string | null>;
      /** 多模态输入：附件二进制上传（renderer File → base64 → 主进程转发 API） */
      uploadAttachment?: (payload: {
        fileName: string;
        mediaType: string;
        purpose: string;
        dataBase64: string;
        idempotencyKey?: string;
      }) => Promise<UploadedAttachment>;
    };
  }
}

/**
 * CR-027：Turn 流【空闲】超时——每收到一条桥消息（delta / reasoning_delta / 心跳等）即重置。
 * 深度思考等长回合持续有事件流入，不再触发误报；真正静默（网络断、上游卡死）时收敛 UI
 * 并经 cancelTurn 通知主进程中止上游请求。
 */
export const DESKTOP_TURN_TIMEOUT_MS = 60_000;
export const desktopTransport: AervoxTransport = {
  async request<T = unknown>(method: string, path: string, body?: unknown, options?: { headers?: Record<string, string> }): Promise<T> {
    const bridge = window.fairyDesktop;
    if (!bridge) throw new Error('fairyDesktop 桥不可用，请通过 Electron 启动应用。');
    const res = await bridge.apiRequest<T>(method, path, body, options?.headers);
    if (!res.ok) throw new Error(`API ${method} ${path} → HTTP ${res.status}: ${res.text}`);
    return res.json as T;
  },

  async streamTurn(
    _sessionId: string,
    content: string,
    callbacks: TurnCallbacks,
    options: StreamTurnOptions = {},
  ): Promise<void> {
    const bridge = window.fairyDesktop;
    if (!bridge) throw new Error('fairyDesktop 桥不可用，请通过 Electron 启动应用。');
    await streamTurnViaBridge(bridge, content, options.toolApprovalMode ?? 'ask', callbacks, options.attachments);
  },

  async submitQuestionAnswers(turnId: string, answers: AskUserQuestionAnswerItem[]): Promise<void> {
    await this.request(
      'POST',
      `/v1/turns/${encodeURIComponent(turnId)}/questions/answers`,
      { answers },
    );
  },

  async uploadAttachment(input: AttachmentUploadInput): Promise<UploadedAttachment> {
    const bridge = window.fairyDesktop;
    if (!bridge?.uploadAttachment) {
      throw new Error('当前桌面桥不支持附件上传，请更新应用后重试。');
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error('附件读取失败'));
      reader.readAsDataURL(input.file);
    });
    const dataBase64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    return bridge.uploadAttachment({
      fileName: input.name,
      mediaType: input.mediaType,
      purpose: input.purpose,
      dataBase64,
      idempotencyKey: input.idempotencyKey,
    });
  },

  async decideToolApproval(turnId: string, approvalId: string, decision: 'granted' | 'denied'): Promise<void> {
    await this.request(
      'POST',
      `/v1/turns/${encodeURIComponent(turnId)}/tool-approvals`,
      { approvalId, decision, decidedBy: 'user' },
    );
  },
};

function streamTurnViaBridge(
  bridge: NonNullable<Window['fairyDesktop']>,
  content: string,
  toolApprovalMode: ToolApprovalMode,
  callbacks: TurnCallbacks,
  attachments?: TurnAttachmentRef[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stop: () => void = () => undefined;
    const requestId = `turn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      stop();
      finish();
    };
    // 空闲超时（替代旧 60s 绝对总时限）：每收到一条桥消息即重置。
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdleTimer = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        settle(() =>
          reject(new Error(`desktop_turn_timeout: no data received for ${DESKTOP_TURN_TIMEOUT_MS}ms`)),
        );
        // UI 已收敛；通知主进程中止仍在等待的上游请求，避免幽灵回合继续消耗 tokens
        bridge.cancelTurn?.(requestId);
      }, DESKTOP_TURN_TIMEOUT_MS);
    };
    armIdleTimer();

    stop = bridge.streamTurn(content, { toolApprovalMode, attachments, requestId }, (message) => {
      armIdleTimer();
      if (!message || typeof message !== 'object') return;
      const envelope = message as { type?: unknown; event?: unknown; message?: unknown };
      if (envelope.type === 'error') {
        settle(() => reject(new Error(typeof envelope.message === 'string' ? envelope.message : 'Aervox 请求失败')));
        return;
      }
      if (envelope.type === 'closed') {
        settle(resolve);
        return;
      }
      if (envelope.type !== 'event' || !envelope.event || typeof envelope.event !== 'object') return;
      const event = envelope.event as TurnStreamEvent;
      if (event.eventType === 'delta') callbacks.onDelta((event.data as { text: string }).text);
      if (event.eventType === 'reasoning_delta') {
        const text = (event.data as { text?: string }).text;
        if (text) callbacks.onReasoning?.(text);
      }
      if (event.eventType === 'done') callbacks.onDone();
      if (event.eventType === 'error') {
        const error = new Error((event.data as { message?: string }).message ?? 'Turn 出错');
        callbacks.onError?.(error);
        settle(() => reject(error));
        return;
      }
      if (event.eventType === 'emote') callbacks.onEmote?.(event.data as PetCommand);
      if (event.eventType === 'user_question_required') {
        callbacks.onUserQuestion?.(event.data as UserQuestionRequiredEventData);
      }
      if (event.eventType === 'tool_approval_required') {
        callbacks.onToolApproval?.({ ...(event.data as ToolApprovalRequiredEventData), turnId: event.turnId });
      }
      if (event.eventType === 'terms_extracted') {
        callbacks.onTermsExtracted?.(event.data as import('@aervox/contracts').TermsExtractedEventData);
      }
    });
  });
}
