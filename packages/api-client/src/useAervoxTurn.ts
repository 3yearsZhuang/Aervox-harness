/**
 * Aervox｜思隅 @aervox/api-client — 对话流式封装
 *
 * 与具体传输解耦：桌面走 IPC transport，Web 走 fetch/SSE transport。
 */
import { getTransport, getSessionId } from './transport';
import type { AskUserQuestionAnswerItem, PetCommand, ToolApprovalRequiredEventData, UserQuestionRequiredEventData } from '@aervox/contracts';

export interface StreamAervoxTurnCallbacks {
  onDelta: (text: string) => void;
  onDone: () => void;
  onError?: (err: unknown) => void;
  onEmote?: (command: PetCommand) => void;
  /** UQ-01: 当模型请求向用户提问时触发 */
  onUserQuestion?: (data: UserQuestionRequiredEventData) => void;
  /** PET-05: 写工具需要用户授权时触发（含 turnId 供授权提交使用） */
  onToolApproval?: (data: ToolApprovalRequiredEventData & { turnId: string }) => void;
}

export async function streamAervoxTurn(content: string, callbacks: StreamAervoxTurnCallbacks): Promise<void> {
  await getTransport().streamTurn(getSessionId(), content, callbacks);
}

export async function submitQuestionAnswers(turnId: string, answers: AskUserQuestionAnswerItem[]): Promise<void> {
  await getTransport().submitQuestionAnswers(turnId, answers);
}

/** PET-05: 提交写工具授权决定；granted 后由调用方重发相同消息命中已授予权限 */
export async function decideToolApproval(turnId: string, approvalId: string, decision: 'granted' | 'denied'): Promise<void> {
  await getTransport().decideToolApproval(turnId, approvalId, decision);
}
