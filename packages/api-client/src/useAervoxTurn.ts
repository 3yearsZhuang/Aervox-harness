/**
 * Aervox｜思隅 @aervox/api-client — 对话流式封装
 *
 * 与具体传输解耦：桌面走 IPC transport，Web 走 fetch/SSE transport。
 */
import { getTransport, getSessionId } from './transport';
import type { AttachmentUploadInput, UploadedAttachment } from './transport';
import type {
  AskUserQuestionAnswerItem,
  PetCommand,
  TermsExtractedEventData,
  ToolApprovalMode,
  ToolApprovalRequiredEventData,
  TurnAttachmentRef,
  UserQuestionRequiredEventData,
  TermExploreRequest,
  TermExploreResponse,
} from '@aervox/contracts';

export interface StreamAervoxTurnCallbacks {
  onDelta: (text: string) => void;
  onDone: () => void;
  onError?: (err: unknown) => void;
  onEmote?: (command: PetCommand) => void;
  /** CR-027: 思考型模型的思考进度增量（reasoning_delta；非正文，仅作「思考中」反馈） */
  onReasoning?: (text: string) => void;
  /** UQ-01: 当模型请求向用户提问时触发 */
  onUserQuestion?: (data: UserQuestionRequiredEventData) => void;
  /** CAP-007 / CAP-002: 术语抽取完成事件 */
  onTermsExtracted?: (data: TermsExtractedEventData) => void;
  /** PET-05: 写工具需要用户授权时触发 */
  onToolApproval?: (data: ToolApprovalRequiredEventData & { turnId: string }) => void;
}

export async function streamAervoxTurn(
  content: string,
  callbacks: StreamAervoxTurnCallbacks,
  options: { toolApprovalMode?: ToolApprovalMode; attachments?: TurnAttachmentRef[] } = {},
): Promise<void> {
  await getTransport().streamTurn(getSessionId(), content, callbacks, options);
}

/** 多模态输入：上传附件二进制（Web 直连 / 桌面经 IPC 桥），返回附件引用 */
export async function uploadAervoxAttachment(input: AttachmentUploadInput): Promise<UploadedAttachment> {
  const transport = getTransport();
  if (!transport.uploadAttachment) {
    throw new Error('当前传输层不支持附件上传');
  }
  return transport.uploadAttachment(input);
}

export async function submitQuestionAnswers(turnId: string, answers: AskUserQuestionAnswerItem[]): Promise<void> {
  await getTransport().submitQuestionAnswers(turnId, answers);
}

export async function exploreTerm(request: TermExploreRequest): Promise<TermExploreResponse> {
  return await getTransport().request<TermExploreResponse>('POST', '/v1/terms/explore', request);
}

export async function decideToolApproval(turnId: string, approvalId: string, decision: 'granted' | 'denied'): Promise<void> {
  await getTransport().decideToolApproval(turnId, approvalId, decision);
}
