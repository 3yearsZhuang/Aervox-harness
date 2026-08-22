/**
 * Aervox｜思隅 @aervox/contracts
 *
 * 对话流式协议（Turn/SSE）的机器可验证契约事实源。
 * 规则依据：docs/contracts/STREAMING_PROTOCOL.md（AVX-SPC-001）。
 * 本包先用 TS 类型固化事件 envelope / 状态机 / 错误码；
 * OpenAPI 3.1 与 JSON Schema 由本包后续生成（生成入口预留，见文件末尾注释）。
 */

/** Turn 状态机（STREAMING_PROTOCOL §3） */
export type TurnStatus =
  | "Created"
  | "InputChecking"
  | "Running"
  | "Finalizing"
  | "Completed"
  | "Rejected"
  | "CancelRequested"
  | "Cancelled"
  | "Interrupted"
  | "Failed";

/** 公开业务 SSE 事件类型（§4） */
export type StreamEventType =
  | "message"
  | "delta"
  | "done"
  | "error"
  | "redacted";

/** 业务事件统一 envelope（§4） */
export interface TurnStreamEvent<TData = unknown> {
  /** 全局稳定且不可复用 */
  eventId: string;
  turnId: string;
  /** Turn 内从 1 单调递增且唯一 */
  sequence: number;
  eventType: StreamEventType;
  payloadVersion: number;
  /** ISO-8601 UTC */
  occurredAt: string;
  modelRunId?: string;
  data: TData;
}

/** message：Assistant Message 身份/可见元数据已提交（§4.1） */
export interface MessageEventData {
  messageId: string;
  role: "assistant";
  contentType: "text" | "markdown";
  isComplete: boolean;
}

/** delta：已通过安全门且已持久化的可见正文（§4.2） */
export interface DeltaEventData {
  messageId: string;
  text: string;
  isFinal: boolean;
}

/** done：Turn 终态已提交（§4.3）；只有 Completed 且 isComplete 才触发下游派生 */
export interface DoneEventData {
  status: Exclude<
    TurnStatus,
    "Created" | "InputChecking" | "Running" | "Finalizing" | "CancelRequested"
  >;
  messageId?: string;
  isComplete: boolean;
  lastSequence: number;
  contextVersion?: string;
}

/** error：已持久化的错误诊断（§4.4） */
export interface ErrorEventData {
  code: StreamErrorCode;
  retryable: boolean;
  message: string;
  lastSequence: number;
}

/** redacted：正文因来源删除/同意撤销/权限变化不再可见（§4.5） */
export interface RedactedEventData {
  targetEventId: string;
  visibilityRevision: number;
  reasonCode: "revoked" | "deleted" | "policy_changed";
  /** 不含原文的替代状态 */
  replacement?: string;
}

/** 标准错误码（§4.5） */
export type StreamErrorCode =
  | "IDEMPOTENCY_KEY_REUSED"
  | "TURN_NOT_FOUND"
  | "STREAM_CURSOR_EXPIRED"
  | "TURN_CANCELLED"
  | "MODEL_TIMEOUT"
  | "MODEL_UNAVAILABLE"
  | "OUTPUT_SAFETY_BLOCKED"
  | "PERMISSION_REVOKED";

/** 创建 Turn 请求体最小字段（§2.1） */
export interface CreateTurnRequest {
  message: {
    content: string;
    contentType: "text" | "markdown";
  };
  clientVersion: string;
  references?: Array<{ sourceId: string; sourceVersion: string }>;
}

/** 创建 Turn 成功响应（§2.1）；重复幂等请求可返回 200 与原资源 */
export interface CreateTurnResponse {
  turnId: string;
  status: "Created";
  eventsUrl: string;
  cancelUrl: string;
}

/** 取消 Turn 响应（§2.3） */
export interface CancelTurnResponse {
  turnId: string;
  status: "CancelRequested" | "Cancelled";
}

/** 事件 payload 判别联合（供消费端收窄） */
export type StreamEventData =
  | MessageEventData
  | DeltaEventData
  | DoneEventData
  | ErrorEventData
  | RedactedEventData;

/** 当前事件 payload 版本 */
export const STREAM_PAYLOAD_VERSION = 1;

/**
 * 预留：OpenAPI 3.1 / JSON Schema 生成入口。
 * 后续在此生成 openapi.yaml 与事件 schema，供服务端校验、客户端类型与契约测试复用。
 */
