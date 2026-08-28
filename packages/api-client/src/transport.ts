/**
 * Aervox｜思隅 @aervox/api-client — 统一传输层
 *
 * 将桌面端（Electron IPC）与 Web（浏览器 fetch/SSE）的差异抽象为单一 Transport 接口，
 * 两端只依赖本接口与领域 composables，不再各自维护实现副本（见 ARCHITECTURE §3.2）。
 */
import type {
  AskUserQuestionAnswerItem,
  PetCommand,
  TurnStreamEvent,
  UserQuestionRequiredEventData,
} from '@aervox/contracts';

export interface TurnCallbacks {
  onDelta: (text: string) => void;
  onDone: () => void;
  onError?: (err: unknown) => void;
  onEmote?: (command: PetCommand) => void;
  /** UQ-01: 当模型请求向用户提问时触发 */
  onUserQuestion?: (data: UserQuestionRequiredEventData) => void;
}

/** 两端能力的最小契约：普通请求 + Turn 流式 + 问答提交 */
export interface AervoxTransport {
  request<T = unknown>(method: string, path: string, body?: unknown, options?: { headers?: Record<string, string> }): Promise<T>;
  streamTurn(sessionId: string, content: string, callbacks: TurnCallbacks): Promise<void>;
  submitQuestionAnswers(turnId: string, answers: AskUserQuestionAnswerItem[]): Promise<void>;
}

// ── 运行时配置（由宿主端在入口注入 import.meta.env 等信息） ──────────────

export interface AervoxClientConfig {
  /** API 基址，仅 fetchTransport 使用（默认 http://127.0.0.1:3000） */
  apiBase?: string;
  /** 可选租户头（Web 环境用 VITE_WORKSPACE_ID / VITE_USER_ID 注入） */
  workspaceId?: string;
  userId?: string;
  /** 学习调度使用的 IANA 时区；默认读取当前系统时区。 */
  timeZone?: string;
  /** 会话 ID（Web 用 VITE_SESSION_ID，默认 web_default） */
  sessionId?: string;
  /** 传输实现：缺省为 fetchTransport */
  transport?: AervoxTransport;
}

interface RuntimeConfig {
  apiBase: string;
  workspaceId?: string;
  userId?: string;
  timeZone: string;
  sessionId: string;
  transport: AervoxTransport;
}

const DEFAULTS: RuntimeConfig = {
  apiBase: 'http://127.0.0.1:3000',
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  sessionId: 'web_default',
  transport: null as unknown as AervoxTransport, // 惰性：未配置时返回 fetchTransport
};

let runtime: RuntimeConfig = { ...DEFAULTS };

export function configureAervoxClient(config: AervoxClientConfig): void {
  runtime = {
    apiBase: config.apiBase?.replace(/\/+$/, '') || runtime.apiBase,
    workspaceId: config.workspaceId ?? runtime.workspaceId,
    userId: config.userId ?? runtime.userId,
    timeZone: config.timeZone ?? runtime.timeZone,
    sessionId: config.sessionId ?? runtime.sessionId,
    transport: config.transport ?? (config.apiBase || config.workspaceId || config.userId
      ? createFetchTransport(config.apiBase?.replace(/\/+$/, '') || runtime.apiBase, config.workspaceId ?? runtime.workspaceId, config.userId ?? runtime.userId)
      : runtime.transport),
  };
}

export function getTransport(): AervoxTransport {
  if (!runtime.transport) {
    runtime.transport = createFetchTransport(runtime.apiBase, runtime.workspaceId, runtime.userId);
  }
  return runtime.transport;
}

/** 当前会话 ID（useAervoxTurn 默认使用） */
export function getSessionId(): string {
  return runtime.sessionId;
}

export function getTimeZone(): string {
  return runtime.timeZone;
}

/** 当前 API 基址（插件 Page iframe 资源地址等场景使用） */
export function getApiBase(): string {
  return runtime.apiBase;
}

// ── fetchTransport（Web / 无桌面桥时的默认实现） ─────────────────────────

export function createFetchTransport(apiBase: string, workspaceId?: string, userId?: string): AervoxTransport {
  const base = apiBase.replace(/\/+$/, '');
  const tenantHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = {};
    if (workspaceId) headers['x-workspace-id'] = workspaceId;
    if (userId) headers['x-user-id'] = userId;
    return headers;
  };

  const request = async <T = unknown>(method: string, path: string, body?: unknown, options?: { headers?: Record<string, string> }): Promise<T> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...tenantHeaders(), ...options?.headers },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    if (!res.ok) throw new Error(`API ${method} ${path} → HTTP ${res.status}`);
    return (await res.json()) as T;
  };

  const streamTurn = async (sessionId: string, content: string, callbacks: TurnCallbacks): Promise<void> => {
    const turn = await request<{ turnId: string }>(
      'POST',
      `/v1/sessions/${encodeURIComponent(sessionId)}/turns`,
      { message: { content, contentType: 'text' }, clientVersion: 'aervox-api-client@0.1' },
    );
    await consumeSse(turn.turnId, callbacks);
  };

  const consumeSse = async (turnId: string, callbacks: TurnCallbacks): Promise<void> => {
    const res = await fetch(`${base}/v1/turns/${encodeURIComponent(turnId)}/events`, {
      headers: { Accept: 'text/event-stream' },
    });
    if (!res.ok || !res.body) throw new Error(`SSE 连接失败 HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() ?? '';
        for (const block of blocks) dispatch(block, callbacks);
      }
    } finally {
      reader.releaseLock();
    }
  };

  const dispatch = (block: string, callbacks: TurnCallbacks): void => {
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!data) return;
    let event: TurnStreamEvent;
    try {
      event = JSON.parse(data) as TurnStreamEvent;
    } catch {
      return;
    }
    if (event.eventType === 'delta') {
      const text = (event.data as { text?: string }).text;
      if (text) callbacks.onDelta(text);
    } else if (event.eventType === 'done') {
      callbacks.onDone();
    } else if (event.eventType === 'error') {
      callbacks.onError?.(new Error((event.data as { message?: string }).message ?? 'Turn 出错'));
    } else if (event.eventType === 'emote') {
      callbacks.onEmote?.(event.data as PetCommand);
    } else if (event.eventType === 'user_question_required') {
      callbacks.onUserQuestion?.(event.data as UserQuestionRequiredEventData);
    }
  };

  const submitQuestionAnswers = async (turnId: string, answers: AskUserQuestionAnswerItem[]): Promise<void> => {
    await request(
      'POST',
      `/v1/turns/${encodeURIComponent(turnId)}/questions/answers`,
      { answers },
    );
  };

  return { request, streamTurn, submitQuestionAnswers };
}
