/**
 * Aervox｜思隅 @aervox/web — 对话流式封装（浏览器 SSE 分支）
 *
 * 桌面端同名 composable 走 preload IPC；web 无桌面桥，走 fetch + SSE。
 */
import { createTurn, consumeTurnEvents } from '../api/stream-turn';

export const defaultSessionId = import.meta.env.VITE_SESSION_ID || 'web_default';

export interface StreamAervoxTurnCallbacks {
  onDelta: (text: string) => void;
  onDone: () => void;
  onError?: (err: unknown) => void;
}

export async function streamAervoxTurn(content: string, callbacks: StreamAervoxTurnCallbacks): Promise<void> {
  const turnId = await createTurn(defaultSessionId, content);
  await consumeTurnEvents(turnId, {
    onDelta: callbacks.onDelta,
    onDone: callbacks.onDone,
    onError: callbacks.onError,
  });
}