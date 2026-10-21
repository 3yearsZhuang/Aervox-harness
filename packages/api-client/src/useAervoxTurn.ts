/**
 * Aervox｜思隅 @aervox/api-client — 对话流式封装
 *
 * 与具体传输解耦：桌面走 IPC transport，Web 走 fetch/SSE transport。
 */
import { getTransport, getSessionId } from './transport';
import { TurnStreamProjector } from './projector';
import type { ToolApprovalDecisionResponse, AttachmentUploadInput, UploadedAttachment } from './transport';
import type {
  AskUserQuestionAnswerItem,
  PetCommand,
  ToolApprovalMode,
  ToolApprovalRequiredEventData,
  TurnAttachmentRef,
  TurnStreamEvent,
  UserQuestionRequiredEventData,
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
  /** CR-060：通用插件事件出口（内核未专门分发的事件一律经此透传） */
  onPluginEvent?: (eventType: string, data: unknown) => void;
  /** PET-05: 写工具需要用户授权时触发 */
  onToolApproval?: (data: ToolApprovalRequiredEventData & { turnId: string }) => void;
}

export async function streamAervoxTurn(
  content: string,
  callbacks: StreamAervoxTurnCallbacks,
  options: { signal?: AbortSignal; toolApprovalMode?: ToolApprovalMode; attachments?: TurnAttachmentRef[]; metadata?: Record<string, unknown>; sessionId?: string } = {},
): Promise<void> {
  await getTransport().streamTurn(options.sessionId ?? getSessionId(), content, callbacks, options);
}

/** 多模态输入：上传附件二进制（Web 直连 / 桌面经 IPC 桥），返回附件引用 */
export async function uploadAervoxAttachment(input: AttachmentUploadInput): Promise<UploadedAttachment> {
  const transport = getTransport();
  if (!transport.uploadAttachment) {
    throw new Error('当前传输层不支持附件上传');
  }
  return transport.uploadAttachment(input);
}

export async function submitQuestionAnswers(turnId: string, answers: AskUserQuestionAnswerItem[], signal?: AbortSignal): Promise<void> {
  await getTransport().submitQuestionAnswers(turnId, answers, signal);
}

/**
 * CR-060：通用请求透传。
 *
 * 插件自有端点的调用不再由宿主逐个包装成具名函数（宿主因此无需知道任何插件路径），
 * 插件自行声明方法、路径与载荷类型。
 */
export async function requestAervoxApi<T = unknown>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  return await getTransport().request<T>(method, path, body);
}

export async function decideToolApproval(turnId: string, approvalId: string, decision: 'granted' | 'denied'): Promise<ToolApprovalDecisionResponse | void> {
  return getTransport().decideToolApproval(turnId, approvalId, decision);
}

/** Observe only the new Attempt's events; the previous terminal projector stays closed. */
export async function watchAervoxTurnContinuation(
  turnId: string, afterEventId: string, callbacks: StreamAervoxTurnCallbacks, signal?: AbortSignal,
): Promise<void> {
  const transport = getTransport();
  if (!transport.streamEvents) throw new Error('event_stream_unavailable');
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const projector = new TurnStreamProjector({ expectedTurnId: turnId });
  try {
    await transport.streamEvents(`/v1/turns/${encodeURIComponent(turnId)}/events?after=${encodeURIComponent(afterEventId)}`, {
      onEvent: value => {
        if (!value || typeof value !== 'object' || !('eventType' in value)) return;
        projector.project(value as TurnStreamEvent, callbacks);
        if (projector.finalized) controller.abort();
      },
    }, combined);
  } catch (error) {
    if (!controller.signal.aborted || !projector.finalized || signal?.aborted) throw error;
  }
  signal?.throwIfAborted();
  if (!projector.finalized) throw new Error('turn_stream_incomplete');
}
