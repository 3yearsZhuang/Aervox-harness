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
        options: { toolApprovalMode: ToolApprovalMode; attachments?: TurnAttachmentRef[] },
        callback: (message: unknown) => void,
      ) => () => void;
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

/** API 上游超时后仍未返回时，桌面端必须收敛 UI 的 loading 状态。 */
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
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      stop();
      finish();
    };
    const timeout = setTimeout(() => {
      settle(() => reject(new Error(`desktop_turn_timeout: no terminal event received within ${DESKTOP_TURN_TIMEOUT_MS}ms`)));
    }, DESKTOP_TURN_TIMEOUT_MS);

    stop = bridge.streamTurn(content, { toolApprovalMode, attachments }, (message) => {
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
      if (event.eventType === 'terms_extracted') {
        callbacks.onTermsExtracted?.(event.data as import('@aervox/contracts').TermsExtractedEventData);
      }
    });
  });
}
