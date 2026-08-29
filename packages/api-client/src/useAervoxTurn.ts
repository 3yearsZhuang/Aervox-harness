/**
 * Aervox｜思隅 @aervox/api-client — 对话流式封装
 *
 * 与具体传输解耦：桌面走 IPC transport，Web 走 fetch/SSE transport。
 */
import { getTransport, getSessionId } from './transport';
import type { AskUserQuestionAnswerItem, PetCommand, ToolApprovalMode, UserQuestionRequiredEventData } from '@aervox/contracts';

export interface StreamAervoxTurnCallbacks {
  onDelta: (text: string) => void;
  onDone: () => void;
  onError?: (err: unknown) => void;
  onEmote?: (command: PetCommand) => void;
  /** UQ-01: 当模型请求向用户提问时触发 */
  onUserQuestion?: (data: UserQuestionRequiredEventData) => void;
}

export async function streamAervoxTurn(
  content: string,
  callbacks: StreamAervoxTurnCallbacks,
  options: { toolApprovalMode?: ToolApprovalMode } = {},
): Promise<void> {
  await getTransport().streamTurn(getSessionId(), content, callbacks, options);
}

export async function submitQuestionAnswers(turnId: string, answers: AskUserQuestionAnswerItem[]): Promise<void> {
  await getTransport().submitQuestionAnswers(turnId, answers);
}
