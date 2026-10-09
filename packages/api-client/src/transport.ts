/**
 * Aervox｜思隅 @aervox/api-client — 统一传输层
 *
 * 将桌面端（Electron IPC）与 Web（浏览器 fetch/SSE）的差异抽象为单一 Transport 接口，
 * 两端只依赖本接口与领域 composables，不再各自维护实现副本（见 ARCHITECTURE §3.2）。
 */
import type {
  AskUserQuestionAnswerItem,
  AttachmentPurpose,
  PetCommand,
  ToolApprovalMode,
  ToolApprovalRequiredEventData,
  TurnAttachmentRef,
  TurnStreamEvent,
  UserQuestionRequiredEventData,
} from '@aervox/contracts';
import type { ProactiveDesktopBridge } from '@aervox/contracts/proactive';
import { TurnStreamProjector } from './projector.js';

export interface TurnCallbacks {
  onDelta: (text: string) => void;
  onDone: () => void;
  onError?: (err: unknown) => void;
  onEmote?: (command: PetCommand) => void;
  /** CR-027: 思考型模型的思考进度增量（reasoning_delta；非正文，仅作「思考中」反馈） */
  onReasoning?: (text: string) => void;
  /** UQ-01: 当模型请求向用户提问时触发 */
  onUserQuestion?: (data: UserQuestionRequiredEventData) => void;
  /**
   * CR-060：通用插件事件出口。
   *
   * 内核未做专门分发的流事件（含插件经 `registerPluginApiContribution` 登记的
   * 自有事件类型）一律经此回调透传，宿主不再为任何插件事件预留专用回调；
   * 载荷结构由声明该事件类型的插件定义与校验。
   */
  onPluginEvent?: (eventType: string, data: unknown) => void;
  /** PET-05: 写工具需要用户授权时触发（含 turnId 供授权提交使用） */
  onToolApproval?: (data: ToolApprovalRequiredEventData & { turnId: string }) => void;
  /** 已通过回合/顺序投影的事件；等待消费者处理以支持终端背压及交互。 */
  onEvent?: (event: TurnStreamEvent) => void | Promise<void>;
}

export interface StreamTurnOptions {
  signal?: AbortSignal;
  idempotencyKey?: string;
  onAccepted?: (turnId: string) => void | Promise<void>;
  toolApprovalMode?: ToolApprovalMode;
  /** 多模态输入：随消息发送的附件引用（先经 uploadAttachment 上传取得 id） */
  attachments?: TurnAttachmentRef[];
  /** Turn 级可选元数据（如 mode: 'study' | 'quiz'） */
  metadata?: Record<string, unknown>;
}

/** 附件上传入参（CAP-012 多模态输入） */
export interface AttachmentUploadInput {
  /** 原始二进制（浏览器 File/Blob；桌面端经 IPC 桥转 base64） */
  file: Blob;
  name: string;
  mediaType: string;
  purpose: AttachmentPurpose;
  idempotencyKey?: string;
}

/** 附件上传结果（attachments 表行子集） */
export interface UploadedAttachment {
  id: string;
  objectKey: string;
  mediaType: string;
  size: number;
  scanStatus?: string;
  purpose?: string | null;
  [key: string]: unknown;
}

export interface EventStreamCallbacks {
  onEvent: (value: unknown) => void;
  onHeartbeat?: () => void;
}

/** 两端能力的最小契约：普通请求 + Turn 流式 + 问答提交 + 附件上传（可选） */
export interface AervoxTransport {
  /** 普通 JSON 事件流；地址、认证和平台通道由传输实现负责。 */
  streamEvents?(path: string, callbacks: EventStreamCallbacks, signal?: AbortSignal): Promise<void>;
  request<T = unknown>(method: string, path: string, body?: unknown, options?: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<T>;
  streamTurn(sessionId: string, content: string, callbacks: TurnCallbacks, options?: StreamTurnOptions): Promise<void>;
  submitQuestionAnswers(turnId: string, answers: AskUserQuestionAnswerItem[], signal?: AbortSignal): Promise<void>;
  /** 多模态输入：原始二进制上传（Web 直连；桌面经 IPC 桥） */
  uploadAttachment?(input: AttachmentUploadInput): Promise<UploadedAttachment>;
  /** PET-05: 写工具授权审批提交 */
  decideToolApproval(turnId: string, approvalId: string, decision: 'granted' | 'denied', signal?: AbortSignal): Promise<void>;
}

// ── 运行时配置（由宿主端在入口注入 import.meta.env 等信息） ──────────────

export interface PlatformServices {
  setTheme?: (theme: 'light' | 'dark') => Promise<'light' | 'dark'>;
  onPetCommand?: (callback: (command: unknown) => void) => () => void;
  pickDirectory?: () => Promise<string | null>;
  proactive?: ProactiveDesktopBridge;
}

export interface AervoxClientConfig {
  platform?: PlatformServices;
  /** API 基址，仅 fetchTransport 使用（默认 http://127.0.0.1:3000） */
  apiBase?: string;
  /** 学习调度使用的 IANA 时区；默认读取当前系统时区。 */
  timeZone?: string;
  /** 会话 ID（Web 用 VITE_SESSION_ID，默认 web_default） */
  sessionId?: string;
  /** 传输实现：缺省为 fetchTransport */
  transport?: AervoxTransport;
}

interface RuntimeConfig {
  platform: PlatformServices;
  apiBase: string;
  timeZone: string;
  sessionId: string;
  transport: AervoxTransport;
}

const DEFAULTS: RuntimeConfig = {
  platform: {},
  apiBase: 'http://127.0.0.1:3000',
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  sessionId: 'web_default',
  transport: null as unknown as AervoxTransport, // 惰性：未配置时返回 fetchTransport
};

let runtime: RuntimeConfig = { ...DEFAULTS };

export function getPlatformServices(): PlatformServices { return runtime.platform; }

export function configureAervoxClient(config: AervoxClientConfig): void {
  runtime = {
    platform: config.platform ?? runtime.platform,
    apiBase: config.apiBase?.replace(/\/+$/, '') || runtime.apiBase,
    timeZone: config.timeZone ?? runtime.timeZone,
    sessionId: config.sessionId ?? runtime.sessionId,
    transport: config.transport ?? (config.apiBase
      ? createFetchTransport(config.apiBase?.replace(/\/+$/, '') || runtime.apiBase)
      : runtime.transport),
  };
}

export function getTransport(): AervoxTransport {
  if (!runtime.transport) {
    runtime.transport = createFetchTransport(runtime.apiBase);
  }
  return runtime.transport;
}

/** 当前会话 ID（useAervoxTurn 默认使用） */
export function getSessionId(): string {
  return runtime.sessionId;
}

/** 设置当前活跃会话 ID */
export function setSessionId(sessionId: string): void {
  runtime.sessionId = sessionId;
}


export function getTimeZone(): string {
  return runtime.timeZone;
}

/** 当前 API 基址（插件 Page iframe 资源地址等场景使用） */
export function getApiBase(): string {
  return runtime.apiBase;
}

// ── fetchTransport（Web / 无桌面桥时的默认实现） ─────────────────────────

/**
 * CR-027：Turn 流空闲超时——创建请求与 SSE 流共用，每收到一段数据即重置。
 * 思考型模型的 reasoning_delta 同样算活性，长思考不再触发超时。
 */
export const TURN_STREAM_IDLE_TIMEOUT_MS = 60_000;

export interface FetchTransportOptions {
  headers?: Record<string, string>;
  requestTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  redirect?: RequestRedirect;
}

export class AervoxHttpError extends Error {
  constructor(public readonly status: number, path: string) {
    super(`API ${path} → HTTP ${status}`);
    this.name = 'AervoxHttpError';
  }
}

export interface FetchTransport extends AervoxTransport {
  watchTurn(turnId: string, callbacks: TurnCallbacks, signal?: AbortSignal): Promise<void>;
  cancelTurn(turnId: string, signal?: AbortSignal): Promise<unknown>;
}

export function createFetchTransport(apiBase: string, config: FetchTransportOptions = {}): FetchTransport {
  const base = apiBase.replace(/\/+$/, '');

  const request = async <T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    options?: { headers?: Record<string, string>; signal?: AbortSignal },
  ): Promise<T> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...config.headers, ...options?.headers },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      signal: config.requestTimeoutMs
        ? AbortSignal.any([AbortSignal.timeout(config.requestTimeoutMs), ...(options?.signal ? [options.signal] : [])])
        : options?.signal,
      redirect: config.redirect,
    });
    if (!res.ok) throw new AervoxHttpError(res.status, `${method} ${path}`);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  };

  const streamEvents = async (path: string, callbacks: EventStreamCallbacks, signal?: AbortSignal): Promise<void> => {
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || path.includes('://')) throw new Error('invalid_event_path');
    signal?.throwIfAborted();
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let timer: ReturnType<typeof setTimeout>;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancelReader = () => { void reader?.cancel().catch(() => undefined); };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new DOMException('event_stream_idle', 'TimeoutError')), config.streamIdleTimeoutMs ?? TURN_STREAM_IDLE_TIMEOUT_MS);
    };
    arm();
    combined.addEventListener('abort', cancelReader, { once: true });
    try {
      const response = await fetch(`${base}${path}`, {
        headers: { ...config.headers, Accept: 'text/event-stream' }, signal: combined, redirect: config.redirect,
      });
      if (!response.ok || !response.body) throw new AervoxHttpError(response.status, 'SSE');
      reader = response.body.getReader();
      combined.throwIfAborted();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const chunk = await reader.read();
        combined.throwIfAborted();
        if (chunk.done) return;
        arm();
        buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, '\n');
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        if (new TextEncoder().encode(buffer).byteLength > 1_048_576) throw new Error('sse_event_too_large');
        for (const frame of frames) {
          combined.throwIfAborted();
          if (new TextEncoder().encode(frame).byteLength > 1_048_576) throw new Error('sse_event_too_large');
          const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
          if (!data) { callbacks.onHeartbeat?.(); continue; }
          let value: unknown;
          try { value = JSON.parse(data); } catch { continue; }
          callbacks.onEvent(value);
        }
      }
    } finally {
      clearTimeout(timer!);
      combined.removeEventListener('abort', cancelReader);
      await reader?.cancel().catch(() => undefined);
      reader?.releaseLock();
    }
  };

  const streamTurn = async (
    sessionId: string,
    content: string,
    callbacks: TurnCallbacks,
    options: StreamTurnOptions = {},
  ): Promise<void> => {
    const message: { content: string; contentType: 'text'; attachments?: TurnAttachmentRef[] } = {
      content,
      contentType: 'text',
    };
    if (options.attachments && options.attachments.length > 0) message.attachments = options.attachments;
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    let timedOut = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdleTimer = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, config.streamIdleTimeoutMs ?? TURN_STREAM_IDLE_TIMEOUT_MS);
    };
    try {
      armIdleTimer();
      const turn = await request<{ turnId: string }>(
        'POST',
        `/v1/sessions/${encodeURIComponent(sessionId)}/turns`,
        {
          message,
          clientVersion: 'aervox-api-client@0.1',
          toolApprovalMode: options.toolApprovalMode ?? 'ask',
          ...(options.metadata ? { metadata: options.metadata } : {}),
        },
        { signal, headers: options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : undefined },
      );
      if (typeof turn.turnId !== 'string' || !turn.turnId) throw new Error('invalid_turn_response');
      await options.onAccepted?.(turn.turnId);
      await consumeSse(turn.turnId, callbacks, signal, armIdleTimer);
    } catch (err) {
      if (timedOut) {
        throw new DOMException('turn_stream_idle', 'TimeoutError');
      }
      throw err;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
    }
  };

  /** 多模态输入：原始二进制直传 POST /v1/attachments/binary（File 即请求体） */
  const uploadAttachment = async (input: AttachmentUploadInput): Promise<UploadedAttachment> => {
    const query = new URLSearchParams({
      fileName: input.name,
      mediaType: input.mediaType,
      purpose: input.purpose,
    });
    if (input.idempotencyKey) query.set('idempotencyKey', input.idempotencyKey);
    const res = await fetch(`${base}/v1/attachments/binary?${query.toString()}`, {
      method: 'POST',
      headers: { ...config.headers, 'Content-Type': input.mediaType },
      body: input.file,
      redirect: config.redirect,
      signal: config.requestTimeoutMs ? AbortSignal.timeout(config.requestTimeoutMs) : undefined,
    });
    if (!res.ok) throw new Error(`API POST /v1/attachments/binary → HTTP ${res.status}`);
    return (await res.json()) as UploadedAttachment;
  };

  const consumeSse = async (
    turnId: string,
    callbacks: TurnCallbacks,
    signal?: AbortSignal,
    armIdleTimer?: () => void,
  ): Promise<void> => {
    const projector = new TurnStreamProjector({ expectedTurnId: turnId });
    let cursor: string | undefined;
    let failure: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      let res: Response;
      try {
        res = await fetch(`${base}/v1/turns/${encodeURIComponent(turnId)}/events`, {
          headers: { ...config.headers, Accept: 'text/event-stream', ...(cursor ? { 'Last-Event-ID': cursor } : {}) }, signal,
          redirect: config.redirect,
        });
      } catch (error) { failure = error; continue; }
      if (!res.ok || !res.body) throw new AervoxHttpError(res.status, 'SSE');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try { chunk = await reader.read(); } catch (error) { failure = error; break; }
          if (chunk.done) break;
          armIdleTimer?.();
          buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, '\n');
          const blocks = buffer.split('\n\n');
          buffer = blocks.pop() ?? '';
          if (new TextEncoder().encode(buffer).byteLength > 1_048_576) throw new Error('sse_event_too_large');
          for (const block of blocks) {
            if (new TextEncoder().encode(block).byteLength > 1_048_576) throw new Error('sse_event_too_large');
            const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
            if (!data) continue;
            let event: TurnStreamEvent;
            try { event = JSON.parse(data) as TurnStreamEvent; } catch { continue; }
            if (projector.project(event, callbacks)) {
              if (event.eventId) cursor = event.eventId;
              await callbacks.onEvent?.(event);
            }
            if (projector.finalized) return;
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }
    signal?.throwIfAborted();
    throw failure ?? new Error('turn_stream_incomplete: reconnect limit reached before terminal event');
  };

  const submitQuestionAnswers = async (turnId: string, answers: AskUserQuestionAnswerItem[], signal?: AbortSignal): Promise<void> => {
    await request(
      'POST',
      `/v1/turns/${encodeURIComponent(turnId)}/questions/answers`,
      { answers },
      { signal },
    );
  };

  const decideToolApproval = async (turnId: string, approvalId: string, decision: 'granted' | 'denied', signal?: AbortSignal): Promise<void> => {
    await request(
      'POST',
      `/v1/turns/${encodeURIComponent(turnId)}/tool-approvals`,
      { approvalId, decision, decidedBy: 'user' },
      { signal },
    );
  };

  const watchTurn = async (turnId: string, callbacks: TurnCallbacks, signal?: AbortSignal): Promise<void> => {
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new DOMException('turn_stream_idle', 'TimeoutError')), config.streamIdleTimeoutMs ?? TURN_STREAM_IDLE_TIMEOUT_MS);
    };
    arm();
    try { await consumeSse(turnId, callbacks, combined, arm); }
    finally { clearTimeout(timer!); }
  };
  const cancelTurn = (turnId: string, signal?: AbortSignal): Promise<unknown> =>
    request('POST', `/v1/turns/${encodeURIComponent(turnId)}/cancel`, {}, { signal });

  return { request, streamEvents, streamTurn, watchTurn, cancelTurn, submitQuestionAnswers, uploadAttachment, decideToolApproval };
}
