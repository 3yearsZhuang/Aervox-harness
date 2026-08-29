/**
 * Aervox｜思隅 @aervox/api-client — 桌面端（Electron IPC）传输实现
 *
 * 包装 preload 暴露的 window.fairyDesktop（apiRequest / streamTurn），
 * 供桌面 renderer 在入口 configureAervoxClient({ transport: desktopTransport }) 注入。
 * 无桥环境（如浏览器预览）下由调用方改用 fetchTransport，本实现不做隐式降级。
 */

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
        options: { toolApprovalMode: ToolApprovalMode },
        callback: (message: unknown) => void,
      ) => () => void;
      /** 打开系统「选择文件夹」对话框，返回选中目录绝对路径；取消返回 null（CR-011 阶段 3） */
      pickDirectory?: () => Promise<string | null>;
    };
  }
}

import type {
  AskUserQuestionAnswerItem,
  PetCommand,
  ToolApprovalMode,
  TurnStreamEvent,
  UserQuestionRequiredEventData,
} from '@aervox/contracts';
import type { AervoxTransport, StreamTurnOptions, TurnCallbacks } from './transport';

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
    await streamTurnViaBridge(bridge, content, options.toolApprovalMode ?? 'ask', callbacks);
  },

  async submitQuestionAnswers(turnId: string, answers: AskUserQuestionAnswerItem[]): Promise<void> {
    await this.request(
      'POST',
      `/v1/turns/${encodeURIComponent(turnId)}/questions/answers`,
      { answers },
    );
  },
};

function streamTurnViaBridge(
  bridge: NonNullable<Window['fairyDesktop']>,
  content: string,
  toolApprovalMode: ToolApprovalMode,
  callbacks: TurnCallbacks,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const stop = bridge.streamTurn(content, { toolApprovalMode }, (message) => {
      if (!message || typeof message !== 'object') return;
      const envelope = message as { type?: unknown; event?: unknown; message?: unknown };
      if (envelope.type === 'error') {
        stop();
        reject(new Error(typeof envelope.message === 'string' ? envelope.message : 'Aervox 请求失败'));
        return;
      }
      if (envelope.type === 'closed') {
        stop();
        resolve();
        return;
      }
      if (envelope.type !== 'event' || !envelope.event || typeof envelope.event !== 'object') return;
      const event = envelope.event as TurnStreamEvent;
      if (event.eventType === 'delta') callbacks.onDelta((event.data as { text: string }).text);
      if (event.eventType === 'done') callbacks.onDone();
      if (event.eventType === 'error') {
        callbacks.onError?.(new Error((event.data as { message?: string }).message ?? 'Turn 出错'));
      }
      if (event.eventType === 'emote') callbacks.onEmote?.(event.data as PetCommand);
      if (event.eventType === 'user_question_required') {
        callbacks.onUserQuestion?.(event.data as UserQuestionRequiredEventData);
      }
      if (event.eventType === 'terms_extracted') {
        callbacks.onTermsExtracted?.(event.data as import('@aervox/contracts').TermsExtractedEventData);
      }
    });
  });
}
