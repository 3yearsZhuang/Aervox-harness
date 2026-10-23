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
  EventStreamCallbacks,
  AttachmentUploadInput,
  StreamTurnOptions,
  ObserveTurnOptions,
  TurnCallbacks,
  UploadedAttachment,
  ToolApprovalDecisionResponse,
} from './transport';
import { TurnStreamProjector } from './projector';
import { AervoxHttpError } from './transport';

declare global {
  interface FairyDesktopBridge {
    streamEvents?: (path: string, callback: (message: unknown) => void | Promise<void>) => () => void;
    apiRequest: <T = unknown>(
      method: string,
      path: string,
      body?: unknown,
      headers?: Record<string, string>,
    ) => Promise<{ status: number; ok: boolean; json: T | null; text: string }>;
    streamTurn: (
      content: string,
      options: {
        sessionId?: string;
        toolApprovalMode: ToolApprovalMode;
        attachments?: TurnAttachmentRef[];
        /** CR-027：渲染层生成的请求 ID，供 cancelTurn 定位主进程在途请求 */
        requestId?: string;
        idempotencyKey?: string;
        metadata?: Record<string, unknown>;
      },
      callback: (message: unknown) => void | Promise<void>,
    ) => () => void;
    observeTurn?: (turnId: string, options: {requestId: string; afterEventId?: string}, callback: (message: unknown) => void | Promise<void>) => () => void;
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
  }
  interface Window {
    fairyDesktop?: FairyDesktopBridge;
  }
}

/**
 * CR-027：Turn 流【空闲】超时——每收到一条桥消息（delta / reasoning_delta / 心跳等）即重置。
 * 深度思考等长回合持续有事件流入，不再触发误报；真正静默（网络断、上游卡死）时收敛 UI
 * 并经 cancelTurn 通知主进程中止上游请求。
 */
export const DESKTOP_TURN_TIMEOUT_MS = 60_000;
export const desktopTransport: AervoxTransport = {
  streamEvents(path: string, callbacks: EventStreamCallbacks, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const bridge = window.fairyDesktop;
    if (!bridge?.streamEvents) return Promise.reject(new Error('event_stream_unavailable'));
    return new Promise((resolve, reject) => {
      let settled = false;
      let stop: (() => void) | undefined;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        stop?.();
        if (error) reject(error); else resolve();
      };
      const onAbort = () => finish(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        stop = bridge.streamEvents!(path, async message => {
          if (settled || !message || typeof message !== 'object') return;
          const envelope = message as { type?: string; event?: unknown; message?: string };
          try {
            if (envelope.type === 'event') await callbacks.onEvent(envelope.event);
            else if (envelope.type === 'heartbeat') callbacks.onHeartbeat?.();
            else if (envelope.type === 'closed') finish();
            else if (envelope.type === 'error') finish(new Error(envelope.message ?? 'event_stream_failed'));
          } catch (error) { finish(error); }
        });
        if (settled) stop();
        else if (signal?.aborted) onAbort();
      } catch (error) { finish(error); }
    });
  },

  async request<T = unknown>(method: string, path: string, body?: unknown, options?: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<T> {
    options?.signal?.throwIfAborted();
    const bridge = window.fairyDesktop;
    if (!bridge) throw new Error('fairyDesktop 桥不可用，请通过 Electron 启动应用。');
    const res = await bridge.apiRequest<T>(method, path, body, options?.headers);
    options?.signal?.throwIfAborted();
    if (!res.ok) {
      const problem = res.json && typeof res.json === 'object' && !Array.isArray(res.json) ? res.json : undefined;
      const error = new AervoxHttpError(res.status, `${method} ${path}`, problem);
      throw error;
    }
    if (res.status === 204) return undefined as T;
    return res.json as T;
  },

  async streamTurn(
    sessionId: string,
    content: string,
    callbacks: TurnCallbacks,
    options: StreamTurnOptions = {},
  ): Promise<void> {
    const bridge = window.fairyDesktop;
    if (!bridge) throw new Error('fairyDesktop 桥不可用，请通过 Electron 启动应用。');
    await streamTurnViaBridge(bridge, callbacks, options, (requestId, callback) => bridge.streamTurn(content, { sessionId, toolApprovalMode: options.toolApprovalMode ?? 'ask', attachments: options.attachments, metadata: options.metadata, idempotencyKey: options.idempotencyKey, requestId }, callback));
  },

  async observeTurn(turnId: string, callbacks: TurnCallbacks, options: ObserveTurnOptions = {}): Promise<void> {
    const bridge = window.fairyDesktop;
    if (!bridge?.observeTurn) throw new Error('turn_observation_unavailable');
    await streamTurnViaBridge(bridge, callbacks, options, (requestId, callback) => bridge.observeTurn!(turnId, {requestId, afterEventId: options.afterEventId}, callback), turnId);
  },

  async submitQuestionAnswers(turnId: string, answers: AskUserQuestionAnswerItem[], signal?: AbortSignal): Promise<void> {
    await this.request(
      'POST',
      `/v1/turns/${encodeURIComponent(turnId)}/questions/answers`,
      { answers },
      { signal },
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

  async decideToolApproval(turnId: string, approvalId: string, decision: 'granted' | 'denied', signal?: AbortSignal): Promise<ToolApprovalDecisionResponse> {
    return this.request<ToolApprovalDecisionResponse>(
      'POST',
      `/v1/turns/${encodeURIComponent(turnId)}/tool-approvals`,
      { approvalId, decision, decidedBy: 'user' },
      { signal },
    );
  },
};

function streamTurnViaBridge(
  bridge: NonNullable<Window['fairyDesktop']>,
  callbacks: TurnCallbacks,
  options: {signal?: AbortSignal; onAccepted?: StreamTurnOptions['onAccepted']},
  start: (requestId: string, callback: (message: unknown) => Promise<void>) => () => void,
  expectedTurnId?: string,
): Promise<void> {
  const signal = options.signal;
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    let stop: () => void = () => undefined;
    const requestId = `turn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (error?: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      clearTimeout(idleTimer);
      stop();
      if (error) reject(error); else resolve();
    };
    const onAbort = () => {
      settle(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      bridge.cancelTurn?.(requestId);
    };
    const arm = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        settle(new Error(`desktop_turn_timeout: no data received for ${DESKTOP_TURN_TIMEOUT_MS}ms`));
        bridge.cancelTurn?.(requestId);
      }, DESKTOP_TURN_TIMEOUT_MS);
    };
    arm();
    const projector = new TurnStreamProjector({expectedTurnId});
    let accepted = false;
    signal?.addEventListener('abort', onAbort, {once: true});
    try {
      stop = start(requestId, async message => {
        if (settled || !message || typeof message !== 'object') return;
        arm();
        const envelope = message as {type?: unknown; event?: unknown; message?: unknown; turnId?: unknown};
        try {
          if (envelope.type === 'accepted' && typeof envelope.turnId === 'string') {
            projector.setExpectedTurnId(envelope.turnId);
            if (!accepted) { accepted = true; clearTimeout(idleTimer); try { await options.onAccepted?.(envelope.turnId); } finally { arm(); } }
          } else if (envelope.type === 'heartbeat') {
            callbacks.onHeartbeat?.();
          } else if (envelope.type === 'error') {
            settle(new Error(typeof envelope.message === 'string' ? envelope.message : 'Aervox 请求失败'));
          } else if (envelope.type === 'closed') {
            settle(projector.finalized ? undefined : new Error('turn_stream_incomplete'));
          } else if (envelope.type === 'event' && envelope.event && typeof envelope.event === 'object') {
            const event = envelope.event as TurnStreamEvent;
            if (projector.project(event, callbacks)) {
              clearTimeout(idleTimer);
              try { await callbacks.onEvent?.(event); } finally { if (!settled) arm(); }
            }
            if (projector.failure) settle(projector.failure);
          }
        } catch (error) { settle(error); throw error; }
      });
      if (settled) stop();
      else if (signal?.aborted) onAbort();
    } catch (error) { settle(error); }
  });
}
