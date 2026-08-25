/**
 * Aervox｜思隅 @aervox/web — Turn/SSE 流式消费（浏览器分支）
 *
 * 遵循 STREAMING_PROTOCOL：POST 创建 Turn 取 turnId，再 GET /v1/turns/{id}/events 消费 SSE。
 * 解析 `data:` 块并分发 delta / done / error 事件。
 */
import type { TurnStreamEvent } from '@aervox/contracts';
import { http, apiBase } from './request';

export interface TurnCallbacks {
  onDelta: (text: string) => void;
  onDone: () => void;
  onError?: (err: unknown) => void;
}

/** 创建 Turn（幂等键由服务端按 header 或自动生成）并返回 turnId */
export async function createTurn(sessionId: string, content: string): Promise<string> {
  const res = await http.post<{ turnId: string }>(
    `/v1/sessions/${encodeURIComponent(sessionId)}/turns`,
    {
      message: { content, contentType: 'text' },
      clientVersion: 'aervox-web@0.1',
    },
  );
  return res.turnId;
}

/** 消费 Turn 的 SSE 事件流直至 done 或连接关闭 */
export async function consumeTurnEvents(turnId: string, callbacks: TurnCallbacks): Promise<void> {
  const res = await fetch(apiBase(`/v1/turns/${encodeURIComponent(turnId)}/events`), {
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
      for (const block of blocks) dispatchBlock(block, callbacks);
    }
  } finally {
    reader.releaseLock();
  }
}

function dispatchBlock(block: string, callbacks: TurnCallbacks): void {
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
  }
}