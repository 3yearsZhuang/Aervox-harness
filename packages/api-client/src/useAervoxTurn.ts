/**
 * Aervox｜思隅 @aervox/api-client — 对话流式封装
 *
 * 与具体传输解耦：桌面走 IPC transport，Web 走 fetch/SSE transport。
 */
import { getTransport, getSessionId } from './transport';
import type { PetCommand } from '@aervox/contracts';

export interface StreamAervoxTurnCallbacks {
  onDelta: (text: string) => void;
  onDone: () => void;
  onError?: (err: unknown) => void;
  onEmote?: (command: PetCommand) => void;
}

export async function streamAervoxTurn(content: string, callbacks: StreamAervoxTurnCallbacks): Promise<void> {
  await getTransport().streamTurn(getSessionId(), content, callbacks);
}