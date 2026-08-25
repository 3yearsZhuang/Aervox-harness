/**
 * Aervox｜思隅 @aervox/api-client — 对话流式封装
 *
 * 与具体传输解耦：桌面走 IPC transport，Web 走 fetch/SSE transport。
 */
import { getTransport, getSessionId } from './transport';

export interface StreamAervoxTurnCallbacks {
  onDelta: (text: string) => void;
  onDone: () => void;
  onError?: (err: unknown) => void;
}

export async function streamAervoxTurn(content: string, callbacks: StreamAervoxTurnCallbacks): Promise<void> {
  await getTransport().streamTurn(getSessionId(), content, callbacks);
}