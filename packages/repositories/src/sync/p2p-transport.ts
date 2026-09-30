/**
 * Aervox｜思隅 @aervox/repositories — 局域网 P2P 同步传输：长度前缀分帧 + 承诺-揭示握手 + 加密 Changeset 交换（ITER-028）
 *
 * ## 这一层做什么
 * 在 `p2p-pairing.ts`（密码学与会话原语）与 `p2p-changeset.ts`（增量合并引擎）之上，
 * 提供**真实 TCP 通道**（`node:net`，无任何第三方依赖）与完整驱动流程：
 * 连接/接受连接 → 承诺-揭示握手 → 把 6 位 SAS 交给调用方 → 调用方显式确认 →
 * 双向交换 AES-256-GCM 加密的 Changeset → 各自 `applyP2PSyncBundle` 合并 → 返回结构化结果。
 *
 * ## 分帧协议（wire format）
 * - 每帧 = 4 字节大端无符号长度 + UTF-8 JSON 体；长度**只描述 JSON 体**；
 * - 单帧硬上限 `maxFrameBytes`（默认 8 MiB）：**编码与解码两侧**都强制，超限立即失败；
 * - 每个报文体都带 `transportVersion`（传输协议版本，独立于配对/变更集版本）；
 * - 读取有界超时；同一连接最多缓存 `maxPendingFrames` 个已解帧（默认 8），
 *   超出即判定协议违规并断开——**不会无界缓冲**。
 *
 * ## 安全语义（务必读完再用）
 * - **传输层绝不代为验证会话**：握手完成后把 `{ session, sasCode, ... }` 交给
 *   `onSessionReady` 回调展示；只有回调返回非 false **且** 调用方自己调用了
 *   `markSessionVerified(session)`（或随后在 `verificationTimeoutMs` 内完成），交换才会继续。
 *   若会话未被标记验证，加密会 fail-closed 抛错，交换以 `session_not_verified` 明确失败。
 * - 收到的报文一律先做**结构与取值校验**再交给密码学层：未知 kind、版本不符、字段缺失/超长、
 *   畸形 JSON 一律拒绝（`P2PTransportError`），绝不"尽力解析"。
 * - 变更集合并沿用 `applyP2PSyncBundle` 的接收端权威白名单等全部安全边界。
 *
 * ## 明确不保证（诚实边界）
 * - **无 TLS**：报文在握手阶段是明文（身份公钥、nonce、签名、临时公钥），
 *   握手之后才是 AES-256-GCM 密文。局域网被动监听者能看到设备身份元数据与握手流量；
 *   防中间人依赖"承诺-揭示 + 6 位 SAS 人工比对 + 指纹固定（TOFU）"，**不是**传输层加密。
 * - 无连接复用、无并发会话：`P2PSyncServer` 一次只处理**一个**对端，
 *   繁忙时新连接收到 `server_busy` 错误帧后被断开（确定性优先，不做排队）。
 * - 无 bundle 分片：单个加密 Changeset 必须放进一帧；超过 `maxFrameBytes` 直接失败，
 *   首次全量同步大库时需调用方自行提高上限或分批。
 * - 无自动重连、无断点续传、无水位线持久化（`sinceWatermark` 由调用方提供）。
 * - 无跨设备真机验收：全部证据来自 127.0.0.1 环回 socket 与单元测试；
 *   真实多网卡 / Wi-Fi 省电 / 移动端后台挂起等场景未验证。
 * - 未接线到产品路径：无 UI、无调度、无 Electron/Capacitor 集成。
 */
import net from "node:net";
import { Buffer } from "node:buffer";
import {
  P2P_PAIRING_PROTOCOL_VERSION,
  P2P_PROTOCOL_VERSION,
  beginPairing,
  completePairingAsInitiatorV2,
  finalizePairingAsResponder,
  respondToPairing,
  verifyResponderKeyConfirmation,
  encryptSyncPayload,
  decryptSyncPayload,
  type EstablishedP2PSession,
  type EncryptedSyncPayload,
  type P2PDeviceDescriptor,
  type P2PDeviceIdentity,
  type PairingInvitation,
  type PairingResponse,
  type PairingReveal,
} from "./p2p-pairing.js";
import {
  applyP2PSyncBundle,
  buildP2PSyncBundle,
  SyncPartialMergeError,
  type P2PSyncBundle,
  type SyncMergeResult,
  type SyncTableDefinition,
  type SyncTableRejectionReason,
} from "./p2p-changeset.js";
import type { Client } from "@libsql/client";

/** 传输协议版本（独立于 `P2P_PROTOCOL_VERSION` 与 `P2P_PAIRING_PROTOCOL_VERSION`） */
export const P2P_TRANSPORT_PROTOCOL_VERSION = "v1";
/** 分帧长度前缀字节数（4 字节大端） */
export const P2P_FRAME_HEADER_BYTES = 4;
/** 单帧硬上限（8 MiB）：编码与解码两侧都强制 */
export const P2P_MAX_FRAME_BYTES = 8 * 1024 * 1024;
/** 同一连接最多缓存的未消费帧数（防止对端刷帧造成无界内存增长） */
export const P2P_MAX_PENDING_FRAMES = 8;
export const P2P_DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
export const P2P_DEFAULT_READ_TIMEOUT_MS = 20_000;
export const P2P_DEFAULT_WRITE_TIMEOUT_MS = 20_000;
export const P2P_DEFAULT_HANDSHAKE_TIMEOUT_MS = 20_000;
export const P2P_DEFAULT_ACK_TIMEOUT_MS = 5_000;
export const P2P_DEFAULT_VERIFICATION_TIMEOUT_MS = 60_000;
export const P2P_DEFAULT_CLOSE_GRACE_MS = 500;
/**
 * 通道失败后延迟销毁 socket 的兜底时长。
 * 故意不立即 destroy：上层 catch 仍有一次机会把错误帧回执给对端（否则对端只会看到"连接被重置"），
 * 但超时后一定销毁，绝不留下半开连接。
 */
export const P2P_FAIL_CLOSE_GRACE_MS = 1_000;
const VERIFICATION_POLL_INTERVAL_MS = 25;
const BEST_EFFORT_ERROR_TIMEOUT_MS = 1_000;

/** 传输层错误码：所有失败路径都必须显式归类，绝不裸抛未知错误 */
export type P2PTransportErrorCode =
  | "frame_too_large"
  | "malformed_frame"
  | "truncated_frame"
  | "too_many_pending_frames"
  | "unsupported_transport_version"
  | "unknown_message_kind"
  | "invalid_message"
  | "connect_timeout"
  | "read_timeout"
  | "write_timeout"
  | "socket_error"
  | "connection_closed"
  | "handshake_failed"
  | "key_confirmation_failed"
  | "session_not_verified"
  | "session_hook_missing"
  | "merge_failed"
  | "peer_error"
  | "server_busy";

/** 传输层/协议层错误（含分帧错误）。`cause` 保留底层原因，绝不静默吞掉 */
export class P2PTransportError extends Error {
  readonly code: P2PTransportErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: P2PTransportErrorCode,
    message: string,
    options: { cause?: unknown; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "P2PTransportError";
    this.code = code;
    if (options.details) this.details = options.details;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/** 分帧层错误（长度前缀/JSON 体/截断/缓冲上限） */
export class P2PFrameError extends P2PTransportError {
  constructor(
    code: Extract<
      P2PTransportErrorCode,
      "frame_too_large" | "malformed_frame" | "truncated_frame" | "too_many_pending_frames"
    >,
    message: string,
    options: { cause?: unknown; details?: Record<string, unknown> } = {},
  ) {
    super(code, message, options);
    this.name = "P2PFrameError";
  }
}

/** 协议层错误（版本不符、未知 kind、字段非法） */
export class P2PTransportProtocolError extends P2PTransportError {
  constructor(
    code: Extract<
      P2PTransportErrorCode,
      "unsupported_transport_version" | "unknown_message_kind" | "invalid_message"
    >,
    message: string,
    options: { cause?: unknown; details?: Record<string, unknown> } = {},
  ) {
    super(code, message, options);
    this.name = "P2PTransportProtocolError";
  }
}

// ---------------------------------------------------------------------------
// 分帧
// ---------------------------------------------------------------------------

/** 把 JSON 体编码为「4 字节大端长度 + UTF-8 JSON」帧；超上限直接拒绝（绝不写出超长帧） */
export function encodeFrame(body: unknown, options: { maxFrameBytes?: number } = {}): Buffer {
  const maxFrameBytes = options.maxFrameBytes ?? P2P_MAX_FRAME_BYTES;
  const json = Buffer.from(JSON.stringify(body), "utf8");
  if (json.byteLength > maxFrameBytes) {
    throw new P2PFrameError(
      "frame_too_large",
      `待发送帧超长：${json.byteLength} > ${maxFrameBytes} 字节（本切片不做 bundle 分片）`,
      { details: { frameBytes: json.byteLength, maxFrameBytes } },
    );
  }
  const header = Buffer.alloc(P2P_FRAME_HEADER_BYTES);
  header.writeUInt32BE(json.byteLength, 0);
  return Buffer.concat([header, json]);
}

/**
 * 流式分帧解码器：只在内存里保留**至多半帧**。
 *
 * - 长度前缀超过 `maxFrameBytes` 时**立即失败**（不预分配、不等待），拒绝内存放大攻击；
 * - JSON 解析失败抛 `malformed_frame`；连接关闭时若有残留半帧，`assertDrained()` 抛 `truncated_frame`。
 */
export class P2PFrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly maxFrameBytes: number;

  constructor(options: { maxFrameBytes?: number } = {}) {
    this.maxFrameBytes = options.maxFrameBytes ?? P2P_MAX_FRAME_BYTES;
  }

  /** 未消费的残留字节数（>0 说明缓冲区里是半帧） */
  get pendingBytes(): number {
    return this.buffer.length;
  }

  /** 当前半帧声明的长度（仅在已读满 4 字节前缀时有意义） */
  get pendingFrameBytes(): number | null {
    if (this.buffer.length < P2P_FRAME_HEADER_BYTES) return null;
    return this.buffer.readUInt32BE(0);
  }

  /** 喂入原始字节，返回本次可解出的完整帧（0..n 个） */
  push(chunk: Buffer): unknown[] {
    if (chunk.length > 0) {
      this.buffer =
        this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk], this.buffer.length + chunk.length);
    }
    const frames: unknown[] = [];
    while (this.buffer.length >= P2P_FRAME_HEADER_BYTES) {
      const frameBytes = this.buffer.readUInt32BE(0);
      if (frameBytes > this.maxFrameBytes) {
        throw new P2PFrameError(
          "frame_too_large",
          `收到超长帧声明：${frameBytes} > ${this.maxFrameBytes} 字节（已断链，拒绝缓冲）`,
          { details: { frameBytes, maxFrameBytes: this.maxFrameBytes } },
        );
      }
      if (this.buffer.length < P2P_FRAME_HEADER_BYTES + frameBytes) break;
      const body = this.buffer.subarray(
        P2P_FRAME_HEADER_BYTES,
        P2P_FRAME_HEADER_BYTES + frameBytes,
      );
      this.buffer = this.buffer.subarray(P2P_FRAME_HEADER_BYTES + frameBytes);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch (error) {
        throw new P2PFrameError("malformed_frame", `帧体不是合法 JSON（${frameBytes} 字节）`, {
          cause: error,
        });
      }
      frames.push(parsed);
    }
    return frames;
  }

  /** 连接关闭时调用：残留半帧必须显式报错，绝不当作"正常结束" */
  assertDrained(): void {
    if (this.buffer.length === 0) return;
    const declared = this.pendingFrameBytes;
    throw new P2PFrameError(
      "truncated_frame",
      `连接在帧中途断开：残留 ${this.buffer.length} 字节` +
        (declared === null ? "（长度前缀未读满）" : `（帧头声明 ${declared} 字节）`),
      { details: { pendingBytes: this.buffer.length, declaredFrameBytes: declared } },
    );
  }
}

// ---------------------------------------------------------------------------
// 报文类型与校验
// ---------------------------------------------------------------------------

export type P2PTransportMessage =
  | { transportVersion: string; kind: "pairing_invitation"; invitation: PairingInvitation }
  | { transportVersion: string; kind: "pairing_response"; response: PairingResponse }
  | { transportVersion: string; kind: "pairing_reveal"; reveal: PairingReveal }
  | { transportVersion: string; kind: "pairing_key_confirmation"; keyConfirmation: string }
  | { transportVersion: string; kind: "sync_bundle"; payload: EncryptedSyncPayload }
  | { transportVersion: string; kind: "sync_result"; mergeResult: SyncMergeResult }
  | {
      transportVersion: string;
      kind: "error";
      errorCode: string;
      message: string;
      partialResult?: SyncMergeResult;
    };

export type P2PTransportMessageKind = P2PTransportMessage["kind"];

/** 已知报文类型白名单（未知 kind 一律拒绝） */
export const P2P_TRANSPORT_MESSAGE_KINDS: readonly P2PTransportMessageKind[] = [
  "pairing_invitation",
  "pairing_response",
  "pairing_reveal",
  "pairing_key_confirmation",
  "sync_bundle",
  "sync_result",
  "error",
];

const MAX_ID_CHARS = 256;
const MAX_TOKEN_CHARS = 8_192;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function requireRecord(value: unknown, context: string): Record<string, unknown> {
  const record = asRecord(value);
  if (!record) {
    throw new P2PTransportProtocolError("invalid_message", `${context} 必须是 JSON 对象`);
  }
  return record;
}

function requireString(
  record: Record<string, unknown>,
  field: string,
  context: string,
  options: { maxChars?: number; allowEmpty?: boolean } = {},
): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new P2PTransportProtocolError(
      "invalid_message",
      `${context} 字段 ${field} 缺失或不是字符串`,
    );
  }
  const maxChars = options.maxChars ?? MAX_ID_CHARS;
  if (!options.allowEmpty && value.length === 0) {
    throw new P2PTransportProtocolError("invalid_message", `${context} 字段 ${field} 不能为空`);
  }
  if (value.length > maxChars) {
    throw new P2PTransportProtocolError(
      "invalid_message",
      `${context} 字段 ${field} 超长：${value.length} > ${maxChars}`,
    );
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  field: string,
  context: string,
  maxChars: number,
): string | undefined {
  const value = record[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new P2PTransportProtocolError("invalid_message", `${context} 字段 ${field} 不是字符串`);
  }
  if (value.length > maxChars) {
    throw new P2PTransportProtocolError(
      "invalid_message",
      `${context} 字段 ${field} 超长：${value.length} > ${maxChars}`,
    );
  }
  return value;
}

/** 校验设备摘要（`Omit<P2PDeviceDescriptor, "host" | "port">`）并重建白名单字段 */
function parseDeviceSummary(
  value: unknown,
  context: string,
): Omit<P2PDeviceDescriptor, "host" | "port"> {
  const record = requireRecord(value, `${context}.device`);
  const publicKey = requireString(record, "publicKey", context, {
    maxChars: MAX_TOKEN_CHARS,
    allowEmpty: true,
  });
  const protocolVersion = requireString(record, "protocolVersion", context, { maxChars: 32 });
  if (protocolVersion !== P2P_PAIRING_PROTOCOL_VERSION && protocolVersion !== P2P_PROTOCOL_VERSION) {
    // v1 是设备描述符版本（P2P_PROTOCOL_VERSION），v2 是配对协议版本；其他一律拒绝
    throw new P2PTransportProtocolError(
      "invalid_message",
      `${context} 设备协议版本不受支持：${protocolVersion}`,
    );
  }
  return {
    deviceId: requireString(record, "deviceId", context),
    deviceName: requireString(record, "deviceName", context, { allowEmpty: true }),
    publicKey,
    protocolVersion,
    fingerprint: requireString(record, "fingerprint", context, { allowEmpty: true }),
  };
}

function parseInvitation(value: unknown): PairingInvitation {
  const record = requireRecord(value, "pairing_invitation.invitation");
  const timestamp = requireString(record, "timestamp", "pairing_invitation", { maxChars: 64 });
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new P2PTransportProtocolError(
      "invalid_message",
      `pairing_invitation.timestamp 不是合法时间戳：${timestamp}`,
    );
  }
  const invitation: PairingInvitation = {
    invitationId: requireString(record, "invitationId", "pairing_invitation"),
    protocolVersion: requireString(record, "protocolVersion", "pairing_invitation", { maxChars: 32 }),
    initiatorDevice: parseDeviceSummary(record.initiatorDevice, "pairing_invitation"),
    timestamp,
    nonce: requireString(record, "nonce", "pairing_invitation", { maxChars: 256 }),
  };
  const commitment = optionalString(record, "commitment", "pairing_invitation", MAX_TOKEN_CHARS);
  if (commitment !== undefined) invitation.commitment = commitment;
  const ephemeralPublicKey = optionalString(
    record,
    "ephemeralPublicKey",
    "pairing_invitation",
    MAX_TOKEN_CHARS,
  );
  if (ephemeralPublicKey !== undefined) invitation.ephemeralPublicKey = ephemeralPublicKey;
  return invitation;
}

function parseResponse(value: unknown): PairingResponse {
  const record = requireRecord(value, "pairing_response.response");
  return {
    invitationId: requireString(record, "invitationId", "pairing_response"),
    protocolVersion: requireString(record, "protocolVersion", "pairing_response", { maxChars: 32 }),
    responderDevice: parseDeviceSummary(record.responderDevice, "pairing_response"),
    ephemeralPublicKey: requireString(record, "ephemeralPublicKey", "pairing_response", {
      maxChars: MAX_TOKEN_CHARS,
    }),
    nonce: requireString(record, "nonce", "pairing_response", { maxChars: 256 }),
    signature: requireString(record, "signature", "pairing_response", { maxChars: MAX_TOKEN_CHARS }),
  };
}

function parseReveal(value: unknown): PairingReveal {
  const record = requireRecord(value, "pairing_reveal.reveal");
  return {
    invitationId: requireString(record, "invitationId", "pairing_reveal"),
    ephemeralPublicKey: requireString(record, "ephemeralPublicKey", "pairing_reveal", {
      maxChars: MAX_TOKEN_CHARS,
    }),
    nonce: requireString(record, "nonce", "pairing_reveal", { maxChars: 256 }),
    signature: requireString(record, "signature", "pairing_reveal", { maxChars: MAX_TOKEN_CHARS }),
    keyConfirmation: requireString(record, "keyConfirmation", "pairing_reveal", {
      maxChars: MAX_TOKEN_CHARS,
    }),
  };
}

function parseEncryptedPayload(value: unknown): EncryptedSyncPayload {
  const record = requireRecord(value, "sync_bundle.payload");
  const sequence = record.sequence;
  if (typeof sequence !== "number" || !Number.isInteger(sequence) || sequence < 0) {
    throw new P2PTransportProtocolError(
      "invalid_message",
      `sync_bundle.payload.sequence 非法：${String(sequence)}`,
    );
  }
  return {
    version: requireString(record, "version", "sync_bundle.payload", { maxChars: 32 }),
    sessionId: requireString(record, "sessionId", "sync_bundle.payload"),
    sequence,
    direction: requireString(record, "direction", "sync_bundle.payload", { maxChars: 64 }),
    iv: requireString(record, "iv", "sync_bundle.payload"),
    ciphertext: requireString(record, "ciphertext", "sync_bundle.payload", {
      maxChars: Number.MAX_SAFE_INTEGER,
      allowEmpty: true,
    }),
    authTag: requireString(record, "authTag", "sync_bundle.payload"),
  };
}

const TABLE_REJECTION_REASONS: readonly SyncTableRejectionReason[] = [
  "not_in_whitelist",
  "primary_key_mismatch",
  "strategy_mismatch",
  "timestamp_column_mismatch",
  "malformed_payload",
];

function readCount(record: Record<string, unknown>, field: string, context: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new P2PTransportProtocolError(
      "invalid_message",
      `${context} 字段 ${field} 必须是非负整数，收到 ${String(value)}`,
    );
  }
  return value;
}

/**
 * 校验并重建对端回传的合并报告。
 * 对端数据一律不可信：未知字段被丢弃，取值/结构非法即拒绝整个报文。
 */
export function parseSyncMergeResult(value: unknown, context = "sync_result.mergeResult"): SyncMergeResult {
  const record = requireRecord(value, context);
  const skippedTablesRaw = record.skippedTables;
  const rejectedTablesRaw = record.rejectedTables;
  if (!Array.isArray(skippedTablesRaw) || !Array.isArray(rejectedTablesRaw)) {
    throw new P2PTransportProtocolError(
      "invalid_message",
      `${context} 的 skippedTables/rejectedTables 必须是数组`,
    );
  }
  const skippedTables = skippedTablesRaw.map((entry) => {
    if (typeof entry !== "string" || entry.length > MAX_ID_CHARS) {
      throw new P2PTransportProtocolError("invalid_message", `${context}.skippedTables 含非法条目`);
    }
    return entry;
  });
  const rejectedTables = rejectedTablesRaw.map((entry) => {
    const item = requireRecord(entry, `${context}.rejectedTables[]`);
    const reason = requireString(item, "reason", `${context}.rejectedTables[]`, { maxChars: 64 });
    if (!TABLE_REJECTION_REASONS.includes(reason as SyncTableRejectionReason)) {
      throw new P2PTransportProtocolError(
        "invalid_message",
        `${context}.rejectedTables[] 拒绝原因未知：${reason}`,
      );
    }
    return {
      tableName: requireString(item, "tableName", `${context}.rejectedTables[]`),
      reason: reason as SyncTableRejectionReason,
      detail: requireString(item, "detail", `${context}.rejectedTables[]`, {
        maxChars: 4_096,
        allowEmpty: true,
      }),
    };
  });
  const partial = record.partial;
  if (typeof partial !== "boolean") {
    throw new P2PTransportProtocolError("invalid_message", `${context}.partial 必须是布尔值`);
  }
  return {
    insertedCount: readCount(record, "insertedCount", context),
    updatedCount: readCount(record, "updatedCount", context),
    skippedCount: readCount(record, "skippedCount", context),
    conflictsResolvedCount: readCount(record, "conflictsResolvedCount", context),
    deletedCount: readCount(record, "deletedCount", context),
    tombstonesApplied: readCount(record, "tombstonesApplied", context),
    uniqueConflicts: readCount(record, "uniqueConflicts", context),
    schemaDriftRows: readCount(record, "schemaDriftRows", context),
    constraintViolations: readCount(record, "constraintViolations", context),
    skippedTables,
    rejectedTables,
    appliedChunks: readCount(record, "appliedChunks", context),
    totalChunks: readCount(record, "totalChunks", context),
    partial,
  };
}

/**
 * 校验并重建传输报文。任何未知 kind、版本不符、字段缺失/非法一律抛
 * `P2PTransportProtocolError`（fail-closed，绝不"尽力解析"）。
 */
export function parseP2PTransportMessage(raw: unknown): P2PTransportMessage {
  const record = requireRecord(raw, "报文");
  const transportVersion = record.transportVersion;
  if (transportVersion !== P2P_TRANSPORT_PROTOCOL_VERSION) {
    throw new P2PTransportProtocolError(
      "unsupported_transport_version",
      `不支持的传输协议版本：${String(transportVersion)}（期望 ${P2P_TRANSPORT_PROTOCOL_VERSION}）`,
      { details: { transportVersion: String(transportVersion) } },
    );
  }
  const kind = record.kind;
  if (typeof kind !== "string" || !P2P_TRANSPORT_MESSAGE_KINDS.includes(kind as P2PTransportMessageKind)) {
    throw new P2PTransportProtocolError(
      "unknown_message_kind",
      `未知报文类型：${String(kind)}（已知：${P2P_TRANSPORT_MESSAGE_KINDS.join(", ")}）`,
      { details: { kind: String(kind) } },
    );
  }
  switch (kind as P2PTransportMessageKind) {
    case "pairing_invitation":
      return {
        transportVersion: P2P_TRANSPORT_PROTOCOL_VERSION,
        kind: "pairing_invitation",
        invitation: parseInvitation(record.invitation),
      };
    case "pairing_response":
      return {
        transportVersion: P2P_TRANSPORT_PROTOCOL_VERSION,
        kind: "pairing_response",
        response: parseResponse(record.response),
      };
    case "pairing_reveal":
      return {
        transportVersion: P2P_TRANSPORT_PROTOCOL_VERSION,
        kind: "pairing_reveal",
        reveal: parseReveal(record.reveal),
      };
    case "pairing_key_confirmation":
      return {
        transportVersion: P2P_TRANSPORT_PROTOCOL_VERSION,
        kind: "pairing_key_confirmation",
        keyConfirmation: requireString(record, "keyConfirmation", "pairing_key_confirmation", {
          maxChars: MAX_TOKEN_CHARS,
        }),
      };
    case "sync_bundle":
      return {
        transportVersion: P2P_TRANSPORT_PROTOCOL_VERSION,
        kind: "sync_bundle",
        payload: parseEncryptedPayload(record.payload),
      };
    case "sync_result":
      return {
        transportVersion: P2P_TRANSPORT_PROTOCOL_VERSION,
        kind: "sync_result",
        mergeResult: parseSyncMergeResult(record.mergeResult),
      };
    case "error": {
      const message: P2PTransportMessage = {
        transportVersion: P2P_TRANSPORT_PROTOCOL_VERSION,
        kind: "error",
        errorCode: requireString(record, "errorCode", "error", { maxChars: 64 }),
        message: requireString(record, "message", "error", { maxChars: 2_048, allowEmpty: true }),
      };
      if (record.partialResult !== undefined && record.partialResult !== null) {
        message.partialResult = parseSyncMergeResult(record.partialResult, "error.partialResult");
      }
      return message;
    }
  }
}

// ---------------------------------------------------------------------------
// socket 读写
// ---------------------------------------------------------------------------

interface PendingRead {
  resolve: (frame: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * 把 socket 字节流转换为"一次一帧"的异步读取口。
 * 失败即记录首因、拒绝等待者并销毁 socket（fail-closed，不留半开连接）。
 */
class FrameChannel {
  private readonly socket: net.Socket;
  private readonly decoder: P2PFrameDecoder;
  private readonly maxPendingFrames: number;
  private readonly queue: unknown[] = [];
  private pending: PendingRead | null = null;
  private failure: Error | null = null;
  private closed = false;
  private destroyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(socket: net.Socket, options: { maxFrameBytes: number; maxPendingFrames?: number }) {
    this.socket = socket;
    this.decoder = new P2PFrameDecoder({ maxFrameBytes: options.maxFrameBytes });
    this.maxPendingFrames = options.maxPendingFrames ?? P2P_MAX_PENDING_FRAMES;
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", (error: Error) => {
      this.fail(
        new P2PTransportError("socket_error", `socket 错误：${error.message}`, { cause: error }),
      );
    });
    socket.on("close", () => this.onClose());
  }

  /** 读取一帧；超时/断链/半帧都会 reject（绝不悬挂） */
  read(timeoutMs: number): Promise<unknown> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.reject(this.closedError());
    if (this.pending) {
      return Promise.reject(
        new P2PTransportError("invalid_message", "FrameChannel 不支持并发读取（协议实现错误）"),
      );
    }
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new P2PTransportError("read_timeout", `等待对端报文超时（${timeoutMs}ms）`));
      }, timeoutMs);
      timer.unref?.();
      this.pending = { resolve, reject, timer };
    });
  }

  /** 摘除监听器并销毁 socket（调用方无需再处理该连接） */
  release(): void {
    this.clearDestroyTimer();
    this.socket.removeAllListeners("data");
    this.socket.removeAllListeners("close");
    this.socket.removeAllListeners("error");
    this.socket.on("error", () => undefined); // 释放后仍吞掉晚到的错误，避免未处理事件打挂进程
    this.closed = true;
  }

  private onData(chunk: Buffer): void {
    if (this.failure) return;
    let frames: unknown[];
    try {
      frames = this.decoder.push(chunk);
    } catch (error) {
      this.fail(
        error instanceof P2PTransportError
          ? error
          : new P2PFrameError("malformed_frame", `分帧失败：${String(error)}`, { cause: error }),
      );
      return;
    }
    for (const frame of frames) {
      const pending = this.pending;
      if (pending) {
        this.pending = null;
        clearTimeout(pending.timer);
        pending.resolve(frame);
        continue;
      }
      if (this.queue.length >= this.maxPendingFrames) {
        this.fail(
          new P2PFrameError(
            "too_many_pending_frames",
            `对端未等待读取即连发超过 ${this.maxPendingFrames} 帧（协议违规，已断链）`,
          ),
        );
        return;
      }
      this.queue.push(frame);
    }
  }

  private onClose(): void {
    this.closed = true;
    this.clearDestroyTimer();
    if (this.failure) return;
    try {
      this.decoder.assertDrained();
    } catch (error) {
      this.fail(error instanceof P2PTransportError ? error : new P2PFrameError("truncated_frame", String(error)));
      return;
    }
    if (this.pending) {
      this.fail(new P2PTransportError("connection_closed", "对端在回复前关闭了连接"));
    }
  }

  private closedError(): Error {
    return (
      this.failure ?? new P2PTransportError("connection_closed", "连接已关闭，无法继续读取")
    );
  }

  private clearDestroyTimer(): void {
    if (this.destroyTimer) {
      clearTimeout(this.destroyTimer);
      this.destroyTimer = null;
    }
  }

  private fail(error: Error): void {
    if (!this.failure) this.failure = error;
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    // 不立刻 destroy：上层（流程 catch）还有一次机会把错误帧回执给对端，
    // 否则对端只会看到"连接被重置"而拿不到任何原因。超时兜底销毁，绝不留半开连接。
    if (!this.socket.destroyed && !this.destroyTimer) {
      this.destroyTimer = setTimeout(() => {
        this.destroyTimer = null;
        if (!this.socket.destroyed) this.socket.destroy();
      }, P2P_FAIL_CLOSE_GRACE_MS);
      this.destroyTimer.unref?.();
    }
  }
}

/** 写入一帧（带超时与背压等待：`write` 回调只在数据交给内核后触发） */
async function writeFrame(
  socket: net.Socket,
  message: P2PTransportMessage,
  options: { maxFrameBytes: number; timeoutMs: number },
): Promise<void> {
  const frame = encodeFrame(message, { maxFrameBytes: options.maxFrameBytes });
  await new Promise<void>((resolve, reject) => {
    if (socket.destroyed) {
      reject(new P2PTransportError("connection_closed", "连接已关闭，无法写入报文"));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new P2PTransportError("write_timeout", `写入对端超时（${options.timeoutMs}ms，对端可能未读取）`),
      );
    }, options.timeoutMs);
    timer.unref?.();
    try {
      socket.write(frame, (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          reject(
            new P2PTransportError("socket_error", `写入失败：${error.message}`, { cause: error }),
          );
        } else {
          resolve();
        }
      });
    } catch (error) {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(
          new P2PTransportError("socket_error", `写入异常：${String(error)}`, { cause: error }),
        );
      }
    }
  });
}

/** 有界优雅关闭：`end()` 后等待对端关闭，超时兜底 `destroy()` */
async function gracefulClose(socket: net.Socket, graceMs: number): Promise<void> {
  if (socket.destroyed) return;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!socket.destroyed) socket.destroy();
      resolve();
    };
    const timer = setTimeout(finish, graceMs);
    timer.unref?.();
    socket.once("close", finish);
    try {
      socket.end();
    } catch {
      finish();
    }
  });
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

// ---------------------------------------------------------------------------
// 交换结果与回调契约
// ---------------------------------------------------------------------------

/** 会话就绪上下文：SAS 必须在此展示给用户 */
export interface P2PSessionReadyContext {
  session: EstablishedP2PSession;
  /** 6 位 SAS；两端独立计算，必须逐位一致 */
  sasCode: string;
  role: "initiator" | "responder";
  remoteDeviceId: string;
  remoteFingerprint: string;
}

/**
 * 会话就绪回调。
 * - 返回 `false`：调用方拒绝本次配对（例如 SAS 不一致），交换立即以 `session_not_verified` 失败；
 * - 返回 `true` 且**调用方自己**调用了 `markSessionVerified(session)`：交换继续；
 * - 返回 `true` 但未标记验证：传输层会在 `verificationTimeoutMs` 内**有界等待**调用方补齐标记，
 *   超时仍以 `session_not_verified` 失败。
 *
 * 传输层**绝不**代为调用 `markSessionVerified`——那是 SAS 人工比对的全部意义所在。
 */
export type P2PSessionReadyHandler = (
  context: P2PSessionReadyContext,
) => boolean | Promise<boolean>;

/** 单次交换的结构化结果 */
export interface P2PExchangeResult {
  role: "initiator" | "responder";
  localDeviceId: string;
  peerDeviceId: string;
  peerFingerprint: string;
  sessionId: string;
  sasCode: string;
  /** 本地应用对端 bundle 的合并报告 */
  localMergeResult: SyncMergeResult;
  /** 对端回执的合并报告；对端未回执即关闭时为 `null`（见 `peerResultMissing`） */
  peerMergeResult: SyncMergeResult | null;
  /** 对端未回执合并结果（连接先被关闭）；显式标记，绝不静默忽略 */
  peerResultMissing: boolean;
  /** 本端或对端任一合并报告 `partial === true`（存在被拒绝表/漂移行/未跑完的批次） */
  partial: boolean;
  peerAddress: string;
  startedAt: string;
  completedAt: string;
}

/** P2P 传输端点共有配置 */
export interface P2PSyncPeerOptions {
  identity: P2PDeviceIdentity;
  /** 本地 SQLite 客户端（写入一律走调用方连接，传输层不新建连接/不开嵌套事务） */
  client: Client;
  /** 设备 ID 覆盖（默认取 `identity.deviceId`；仅测试友好，一般不要传） */
  deviceId?: string;
  /** 同步表白名单（默认 `DEFAULT_SYNC_TABLES`） */
  tables?: SyncTableDefinition[];
  /** 合并分批行数（默认沿用 `SYNC_MERGE_CHUNK_SIZE`；调小便于验证部分合并行为） */
  mergeChunkSize?: number;
  /** 指纹固定（TOFU）：deviceId → 已知指纹；不一致时握手 fail-closed */
  trustedFingerprints?: Record<string, string>;
  /** 会话就绪回调（**必填**：SAS 必须交给调用方决定） */
  onSessionReady: P2PSessionReadyHandler;
  maxFrameBytes?: number;
  maxPendingFrames?: number;
  readTimeoutMs?: number;
  writeTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  ackTimeoutMs?: number;
  /** 等待调用方 `markSessionVerified` 的有界时长 */
  verificationTimeoutMs?: number;
  closeGraceMs?: number;
  /** 错误上报（服务端不抛给调用方，必须经此上报；绝不静默吞错） */
  onError?: (error: Error, context: { phase: string; peerAddress?: string }) => void;
}

/** 发起方（客户端）配置 */
export interface P2PSyncClientOptions extends P2PSyncPeerOptions {
  /** 对端地址（通常来自 `P2PDiscovery.listPeers()` 或静态对端列表） */
  peer: { host: string; port: number };
  /** 本端出站 bundle 的时间水位线（语义「已包含」，由调用方持久化） */
  sinceWatermark?: string;
  connectTimeoutMs?: number;
}

/** 接受方（服务端）配置 */
export interface P2PSyncServerOptions extends P2PSyncPeerOptions {
  host?: string;
  /** 监听端口；`0` 表示由系统分配（`start()` 返回真实端口） */
  port?: number;
  /** 按对端设备 ID 提供本端出站 bundle 的水位线 */
  sinceWatermark?: (peerDeviceId: string) => string | undefined;
  /** 每次交换结束（无论成败由 `onError` 负责）后回调 */
  onExchange?: (result: P2PExchangeResult) => void;
}

interface NormalizedPeerConfig {
  identity: P2PDeviceIdentity;
  deviceId: string;
  client: Client;
  tables: SyncTableDefinition[] | undefined;
  mergeChunkSize: number | undefined;
  trustedFingerprints: Record<string, string> | undefined;
  onSessionReady: P2PSessionReadyHandler;
  maxFrameBytes: number;
  maxPendingFrames: number;
  readTimeoutMs: number;
  writeTimeoutMs: number;
  handshakeTimeoutMs: number;
  ackTimeoutMs: number;
  verificationTimeoutMs: number;
  closeGraceMs: number;
  onError: ((error: Error, context: { phase: string; peerAddress?: string }) => void) | undefined;
}

function normalizePeerConfig(options: P2PSyncPeerOptions): NormalizedPeerConfig {
  if (typeof options.onSessionReady !== "function") {
    throw new P2PTransportError(
      "session_hook_missing",
      "必须提供 onSessionReady 回调：传输层不会代为验证会话（fail-closed）",
    );
  }
  if (!options.identity?.deviceId) {
    throw new P2PTransportError("invalid_message", "缺少合法的本机设备身份");
  }
  if (!options.client) {
    throw new P2PTransportError("invalid_message", "缺少本地 SQLite 客户端");
  }
  return {
    identity: options.identity,
    deviceId: options.deviceId ?? options.identity.deviceId,
    client: options.client,
    tables: options.tables,
    mergeChunkSize: options.mergeChunkSize,
    trustedFingerprints: options.trustedFingerprints,
    onSessionReady: options.onSessionReady,
    maxFrameBytes: options.maxFrameBytes ?? P2P_MAX_FRAME_BYTES,
    maxPendingFrames: options.maxPendingFrames ?? P2P_MAX_PENDING_FRAMES,
    readTimeoutMs: options.readTimeoutMs ?? P2P_DEFAULT_READ_TIMEOUT_MS,
    writeTimeoutMs: options.writeTimeoutMs ?? P2P_DEFAULT_WRITE_TIMEOUT_MS,
    handshakeTimeoutMs: options.handshakeTimeoutMs ?? P2P_DEFAULT_HANDSHAKE_TIMEOUT_MS,
    ackTimeoutMs: options.ackTimeoutMs ?? P2P_DEFAULT_ACK_TIMEOUT_MS,
    verificationTimeoutMs: options.verificationTimeoutMs ?? P2P_DEFAULT_VERIFICATION_TIMEOUT_MS,
    closeGraceMs: options.closeGraceMs ?? P2P_DEFAULT_CLOSE_GRACE_MS,
    onError: options.onError,
  };
}

// ---------------------------------------------------------------------------
// 流程公共步骤
// ---------------------------------------------------------------------------

/** 按期望类型读取一帧；收到 `error` 帧或类型不符时抛带 code 的明确错误 */
async function readExpected<K extends P2PTransportMessageKind>(
  channel: FrameChannel,
  kind: K,
  timeoutMs: number,
  phase: string,
): Promise<Extract<P2PTransportMessage, { kind: K }>> {
  const raw = await channel.read(timeoutMs);
  const message = parseP2PTransportMessage(raw);
  if (message.kind === "error") {
    const details: Record<string, unknown> = { remoteCode: message.errorCode, phase };
    if (message.partialResult) details.remotePartialResult = message.partialResult;
    throw new P2PTransportError(
      "peer_error",
      `${phase}：对端报告错误 [${message.errorCode}] ${message.message}`,
      { details },
    );
  }
  if (message.kind !== kind) {
    throw new P2PTransportProtocolError(
      "invalid_message",
      `${phase}：期望 ${kind}，收到 ${message.kind}（协议顺序违规）`,
      { details: { expected: kind, actual: message.kind, phase } },
    );
  }
  return message as Extract<P2PTransportMessage, { kind: K }>;
}

/** 尽力发送错误回执（失败只上报，绝不再抛；用于错误路径避免"对端空等"） */
async function sendErrorFrameBestEffort(
  socket: net.Socket,
  config: NormalizedPeerConfig,
  error: Error,
  peerAddress: string,
): Promise<void> {
  if (socket.destroyed) return;
  const code =
    error instanceof SyncPartialMergeError
      ? "partial_merge"
      : error instanceof P2PTransportError
        ? error.code
        : "unexpected_error";
  const partialResult =
    error instanceof SyncPartialMergeError ? error.partialResult : undefined;
  const message: P2PTransportMessage = {
    transportVersion: P2P_TRANSPORT_PROTOCOL_VERSION,
    kind: "error",
    errorCode: code,
    message: error.message.slice(0, 2_000),
    ...(partialResult ? { partialResult } : {}),
  };
  try {
    await writeFrame(socket, message, {
      maxFrameBytes: config.maxFrameBytes,
      timeoutMs: BEST_EFFORT_ERROR_TIMEOUT_MS,
    });
  } catch (sendError) {
    // 错误回执本身失败不应覆盖原始错误：只上报，调用方仍会拿到首因
    config.onError?.(
      sendError instanceof Error ? sendError : new Error(String(sendError)),
      { phase: "error_frame", peerAddress },
    );
  }
}

/**
 * 把 SAS 交给调用方，并**有界等待**其显式 `markSessionVerified`。
 * 传输层绝不代为验证：未验证会话在加密时会 fail-closed 抛错，这里提前给出更清晰的失败原因。
 */
async function awaitSessionVerified(options: {
  config: NormalizedPeerConfig;
  session: EstablishedP2PSession;
  sasCode: string;
  role: "initiator" | "responder";
  peerAddress: string;
}): Promise<void> {
  const { config, session, sasCode, role } = options;
  const context: P2PSessionReadyContext = {
    session,
    sasCode,
    role,
    remoteDeviceId: session.remoteDeviceId,
    remoteFingerprint: session.remoteFingerprint,
  };
  let accepted: boolean;
  try {
    accepted = (await config.onSessionReady(context)) !== false;
  } catch (error) {
    throw new P2PTransportError(
      "session_not_verified",
      `onSessionReady 回调抛错，已 fail-closed 中止交换：${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  if (!accepted) {
    throw new P2PTransportError(
      "session_not_verified",
      "调用方拒绝了本次配对（SAS 不一致或用户取消），已中止交换",
    );
  }
  if (session.verified) return;

  const deadline = Date.now() + config.verificationTimeoutMs;
  while (Date.now() < deadline) {
    await delay(VERIFICATION_POLL_INTERVAL_MS);
    if (session.verified) return;
  }
  throw new P2PTransportError(
    "session_not_verified",
    `会话在 ${config.verificationTimeoutMs}ms 内未被 markSessionVerified 标记为已验证；` +
      "传输层不会代为验证（SAS 人工比对是防中间人的关键步骤）",
  );
}

/** 应用对端 bundle：`SyncPartialMergeError` 原样上抛（保留 partialResult），其余合并失败统一归类 */
async function applyPeerBundle(
  config: NormalizedPeerConfig,
  bundle: P2PSyncBundle,
): Promise<SyncMergeResult> {
  try {
    return await applyP2PSyncBundle(config.client, bundle, config.deviceId, {
      tables: config.tables,
      chunkSize: config.mergeChunkSize,
    });
  } catch (error) {
    if (error instanceof SyncPartialMergeError) throw error;
    throw new P2PTransportError(
      "merge_failed",
      `本地合并对端 Changeset 失败：${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
        details: { originalErrorName: error instanceof Error ? error.name : typeof error },
      },
    );
  }
}

/** 本地出站 bundle 构建（加密前的最后一步，参数全部来自调用方） */
async function buildOutgoingBundle(
  config: NormalizedPeerConfig,
  targetDeviceId: string,
  sinceWatermark: string | undefined,
): Promise<P2PSyncBundle> {
  return buildP2PSyncBundle(config.client, {
    sourceDeviceId: config.deviceId,
    targetDeviceId,
    sinceWatermark,
    tables: config.tables,
  });
}

// ---------------------------------------------------------------------------
// 发起方（客户端）
// ---------------------------------------------------------------------------

/**
 * 发起方：连接对端 → 承诺-揭示握手 → SAS 交由调用方确认 → 双向加密 Changeset 交换。
 *
 * 单次 `run()` 只做一次交换；连接在结束时无论成败都会被关闭（带兜底超时）。
 */
export class P2PSyncClient {
  private readonly config: NormalizedPeerConfig;
  private readonly peer: { host: string; port: number };
  private readonly sinceWatermark: string | undefined;
  private readonly connectTimeoutMs: number;

  constructor(options: P2PSyncClientOptions) {
    this.config = normalizePeerConfig(options);
    this.peer = options.peer;
    this.sinceWatermark = options.sinceWatermark;
    this.connectTimeoutMs = options.connectTimeoutMs ?? P2P_DEFAULT_CONNECT_TIMEOUT_MS;
  }

  async run(): Promise<P2PExchangeResult> {
    const startedAt = new Date().toISOString();
    const peerAddress = `${this.peer.host}:${this.peer.port}`;
    const socket = await this.connect(peerAddress);
    const channel = new FrameChannel(socket, {
      maxFrameBytes: this.config.maxFrameBytes,
      maxPendingFrames: this.config.maxPendingFrames,
    });
    try {
      return await this.runInitiatorFlow(socket, channel, peerAddress, startedAt);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      await sendErrorFrameBestEffort(socket, this.config, failure, peerAddress);
      throw failure;
    } finally {
      channel.release();
      await gracefulClose(socket, this.config.closeGraceMs);
    }
  }

  private connect(peerAddress: string): Promise<net.Socket> {
    const { host, port } = this.peer;
    return new Promise<net.Socket>((resolve, reject) => {
      let settled = false;
      const socket = net.connect({ host, port });
      socket.setNoDelay(true);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(
          new P2PTransportError("connect_timeout", `连接 ${peerAddress} 超时（${this.connectTimeoutMs}ms）`),
        );
      }, this.connectTimeoutMs);
      timer.unref?.();
      socket.once("connect", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(socket);
      });
      socket.once("error", (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(
          new P2PTransportError("socket_error", `连接 ${peerAddress} 失败：${error.message}`, {
            cause: error,
          }),
        );
      });
    });
  }

  private async runInitiatorFlow(
    socket: net.Socket,
    channel: FrameChannel,
    peerAddress: string,
    startedAt: string,
  ): Promise<P2PExchangeResult> {
    const config = this.config;
    const writeOptions = { maxFrameBytes: config.maxFrameBytes, timeoutMs: config.writeTimeoutMs };

    // 1. 消息 1：带承诺的配对邀请（不泄露临时公钥）
    const pending = beginPairing(config.identity);
    await writeFrame(
      socket,
      {
        transportVersion: P2P_TRANSPORT_PROTOCOL_VERSION,
        kind: "pairing_invitation",
        invitation: pending.invitation,
      },
      writeOptions,
    );

    // 2. 消息 2：响应方揭示临时公钥并对 transcript 签名
    const responseMessage = await readExpected(
      channel,
      "pairing_response",
      config.handshakeTimeoutMs,
      "等待配对响应",
    );
    const response = responseMessage.response;
    let completed: ReturnType<typeof completePairingAsInitiatorV2>;
    try {
      completed = completePairingAsInitiatorV2(config.identity, pending, response, {
        expectedRemoteFingerprint: config.trustedFingerprints?.[response.responderDevice.deviceId],
      });
    } catch (error) {
      throw new P2PTransportError(
        "handshake_failed",
        `承诺-揭示握手失败（响应校验）：${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    // 3. 消息 3：揭示临时公钥 + 身份签名 + 会话密钥确认
    await writeFrame(
      socket,
      {
        transportVersion: P2P_TRANSPORT_PROTOCOL_VERSION,
        kind: "pairing_reveal",
        reveal: completed.reveal,
      },
      writeOptions,
    );

    // 4. 校验响应方密钥确认（r2i 域分离：回声无法通过）
    const confirmationMessage = await readExpected(
      channel,
      "pairing_key_confirmation",
      config.handshakeTimeoutMs,
      "等待密钥确认",
    );
    const responderConfirmed = verifyResponderKeyConfirmation({
      session: completed.session,
      invitation: pending.invitation,
      response,
      initiatorEphemeralPublicKey: pending.ephemeralEcdh.getPublicKey().toString("base64"),
      keyConfirmation: confirmationMessage.keyConfirmation,
    });
    if (!responderConfirmed) {
      throw new P2PTransportError(
        "key_confirmation_failed",
        "响应方未能证明其持有派生出的会话密钥（可能中间人/实现不一致）",
      );
    }

    // 5. SAS 交给调用方，等待其显式 markSessionVerified
    await awaitSessionVerified({
      config,
      session: completed.session,
      sasCode: completed.sasCode,
      role: "initiator",
      peerAddress,
    });

    // 6. 发送本端加密 bundle
    const bundle = await buildOutgoingBundle(
      config,
      completed.session.remoteDeviceId,
      this.sinceWatermark,
    );
    const payload = encryptSyncPayload(completed.session, bundle);
    await writeFrame(
      socket,
      { transportVersion: P2P_TRANSPORT_PROTOCOL_VERSION, kind: "sync_bundle", payload },
      writeOptions,
    );

    // 7. 接收并应用对端 bundle
    const peerBundleMessage = await readExpected(
      channel,
      "sync_bundle",
      config.readTimeoutMs,
      "等待对端 Changeset",
    );
    const peerBundle = decryptSyncPayload<P2PSyncBundle>(
      completed.session,
      peerBundleMessage.payload,
    );
    const localMergeResult = await applyPeerBundle(config, peerBundle);

    // 8. 回执本端合并报告（对端据此获得 peerMergeResult）
    await writeFrame(
      socket,
      {
        transportVersion: P2P_TRANSPORT_PROTOCOL_VERSION,
        kind: "sync_result",
        mergeResult: localMergeResult,
      },
      writeOptions,
    );

    // 9. 读取对端回执：对端未回执即关闭时显式标记为缺失，不静默忽略
    const peerResult = await readPeerResultBestEffort(
      channel,
      config.ackTimeoutMs,
      config.onError,
      peerAddress,
    );

    return {
      role: "initiator",
      localDeviceId: config.deviceId,
      peerDeviceId: completed.session.remoteDeviceId,
      peerFingerprint: completed.session.remoteFingerprint,
      sessionId: completed.session.sessionId,
      sasCode: completed.sasCode,
      localMergeResult,
      peerMergeResult: peerResult.result,
      peerResultMissing: peerResult.missing,
      partial: localMergeResult.partial || peerResult.result?.partial === true,
      peerAddress,
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }
}

/** 便捷函数：构造一次性客户端并执行交换 */
export async function performP2PSyncExchange(
  options: P2PSyncClientOptions,
): Promise<P2PExchangeResult> {
  return new P2PSyncClient(options).run();
}

// ---------------------------------------------------------------------------
// 接受方（服务端）
// ---------------------------------------------------------------------------

function withTimeout(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    }),
  ]);
}

/**
 * 接受方服务端：监听端口，一次只处理一个对端（确定性优先）。
 *
 * - 繁忙时新连接收到 `server_busy` 错误帧后被断开（不排队，避免无界等待）；
 * - 单连接内的任何错误都通过 `onError` 上报并回执错误帧，服务本身保持可用；
 * - `stop()` 幂等：清空连接、关闭监听，绝不留下阻止进程退出的句柄。
 */
export class P2PSyncServer {
  private readonly config: NormalizedPeerConfig;
  private readonly host: string;
  private readonly port: number;
  private readonly sinceWatermark: ((peerDeviceId: string) => string | undefined) | undefined;
  private readonly onExchange: ((result: P2PExchangeResult) => void) | undefined;

  private server: net.Server | null = null;
  private running = false;
  private stopping = false;
  private busy = false;
  private boundPort: number | null = null;
  private listenSettled: Promise<void> | null = null;
  private settleListen: (() => void) | null = null;
  private readonly sockets = new Set<net.Socket>();

  constructor(options: P2PSyncServerOptions) {
    this.config = normalizePeerConfig(options);
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 0;
    this.sinceWatermark = options.sinceWatermark;
    this.onExchange = options.onExchange;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** 实际监听地址（未启动时为 null） */
  address(): { host: string; port: number } | null {
    if (!this.running) return null;
    const address = this.server?.address();
    const port = typeof address === "object" && address ? address.port : this.boundPort;
    if (port === null || port === undefined) return null;
    return { host: this.host, port };
  }

  /** 启动监听（幂等）；`port: 0` 时返回系统分配的真实端口 */
  async start(): Promise<{ host: string; port: number }> {
    const existing = this.address();
    if (this.running && existing) return existing;
    this.stopping = false;

    // 与 worker-ipc 同样的竞态处理：先建立 listen 落地信号，stop() 才能安全等待
    this.listenSettled = new Promise<void>((resolve) => {
      this.settleListen = resolve;
    });

    return new Promise<{ host: string; port: number }>((resolve, reject) => {
      const server = net.createServer((socket) => {
        void this.handleConnection(socket);
      });
      this.server = server;

      let settled = false;
      const markListenSettled = () => {
        const settle = this.settleListen;
        this.settleListen = null;
        settle?.();
      };

      server.once("error", (error: Error) => {
        if (settled) return;
        settled = true;
        this.running = false;
        if (this.server === server) this.server = null;
        markListenSettled();
        reject(
          new P2PTransportError(
            "socket_error",
            `监听 ${this.host}:${this.port} 失败：${error.message}`,
            { cause: error },
          ),
        );
      });

      server.listen({ host: this.host, port: this.port }, () => {
        if (settled) return;
        settled = true;
        if (this.stopping) {
          try {
            server.close(() => undefined);
          } catch {
            // 已关闭
          }
          if (this.server === server) this.server = null;
          this.running = false;
          markListenSettled();
          resolve({ host: this.host, port: 0 });
          return;
        }
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : this.port;
        this.boundPort = port;
        this.running = true;
        markListenSettled();
        resolve({ host: this.host, port });
      });
    });
  }

  /** 关闭服务端（幂等）：断开所有连接、关闭监听，带兜底超时 */
  async stop(): Promise<void> {
    this.stopping = true;
    this.running = false;

    for (const socket of [...this.sockets]) {
      socket.destroy();
    }
    this.sockets.clear();

    const server = this.server;
    this.server = null;

    const listenSettled = this.listenSettled;
    this.listenSettled = null;
    if (listenSettled) await withTimeout(listenSettled, 250);

    if (server) {
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve();
        };
        try {
          server.close(() => finish());
        } catch {
          finish();
        }
        const timer = setTimeout(finish, 250);
        timer.unref?.();
      });
    }
  }

  private async handleConnection(socket: net.Socket): Promise<void> {
    this.sockets.add(socket);
    const peerAddress = `${socket.remoteAddress ?? "unknown"}:${socket.remotePort ?? 0}`;
    // 注意：socket 可能已被对端在握手前关闭（例如只写半帧就断链的探测连接），
    // 因此所有 socket 操作都必须在 try 内，绝不能让 setNoDelay 之类的异常变成未处理的 rejection。
    let channel: FrameChannel | null = null;

    try {
      try {
        socket.setNoDelay(true);
      } catch {
        // 已销毁的 socket：下面对它的读写会直接失败并走到统一错误上报
      }
      channel = new FrameChannel(socket, {
        maxFrameBytes: this.config.maxFrameBytes,
        maxPendingFrames: this.config.maxPendingFrames,
      });

      if (this.busy || this.stopping) {
        await writeFrame(
          socket,
          {
            transportVersion: P2P_TRANSPORT_PROTOCOL_VERSION,
            kind: "error",
            errorCode: this.stopping ? "server_stopping" : "server_busy",
            message: this.stopping
              ? "服务端正在关闭，拒绝新连接"
              : "服务端一次只处理一个对端（server_busy），请稍后重试",
          },
          { maxFrameBytes: this.config.maxFrameBytes, timeoutMs: BEST_EFFORT_ERROR_TIMEOUT_MS },
        ).catch(() => undefined);
        return;
      }
      this.busy = true;
      const result = await this.runResponderFlow(socket, channel, peerAddress);
      this.onExchange?.(result);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.config.onError?.(failure, { phase: "exchange", peerAddress });
      await sendErrorFrameBestEffort(socket, this.config, failure, peerAddress);
    } finally {
      this.busy = false;
      this.sockets.delete(socket);
      channel?.release();
      await gracefulClose(socket, this.config.closeGraceMs);
    }
  }

  private async runResponderFlow(
    socket: net.Socket,
    channel: FrameChannel,
    peerAddress: string,
  ): Promise<P2PExchangeResult> {
    const config = this.config;
    const startedAt = new Date().toISOString();
    const writeOptions = { maxFrameBytes: config.maxFrameBytes, timeoutMs: config.writeTimeoutMs };

    // 1. 消息 1：必须是带承诺的配对邀请
    const invitationMessage = await readExpected(
      channel,
      "pairing_invitation",
      config.handshakeTimeoutMs,
      "等待配对邀请",
    );
    const invitation = invitationMessage.invitation;
    if (!invitation.commitment) {
      throw new P2PTransportError(
        "handshake_failed",
        "配对邀请缺少临时公钥承诺（遗留不安全路径不被传输层接受）",
      );
    }

    // 2. 消息 2：揭示本端临时公钥并签名
    let responded: ReturnType<typeof respondToPairing>;
    try {
      responded = respondToPairing(config.identity, invitation);
    } catch (error) {
      throw new P2PTransportError(
        "handshake_failed",
        `承诺-揭示握手失败（邀请校验）：${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    await writeFrame(
      socket,
      {
        transportVersion: P2P_TRANSPORT_PROTOCOL_VERSION,
        kind: "pairing_response",
        response: responded.response,
      },
      writeOptions,
    );

    // 3. 消息 3：校验承诺/身份签名/密钥确认，派生会话密钥
    const revealMessage = await readExpected(
      channel,
      "pairing_reveal",
      config.handshakeTimeoutMs,
      "等待配对揭示",
    );
    let finalized: ReturnType<typeof finalizePairingAsResponder>;
    try {
      finalized = finalizePairingAsResponder(config.identity, responded.pending, invitation, revealMessage.reveal, {
        expectedRemoteFingerprint: config.trustedFingerprints?.[invitation.initiatorDevice.deviceId],
      });
    } catch (error) {
      throw new P2PTransportError(
        "handshake_failed",
        `承诺-揭示握手失败（揭示校验）：${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    await writeFrame(
      socket,
      {
        transportVersion: P2P_TRANSPORT_PROTOCOL_VERSION,
        kind: "pairing_key_confirmation",
        keyConfirmation: finalized.keyConfirmation,
      },
      writeOptions,
    );

    // 4. SAS 交给调用方，等待其显式 markSessionVerified（绝不代为验证）
    await awaitSessionVerified({
      config,
      session: finalized.session,
      sasCode: finalized.sasCode,
      role: "responder",
      peerAddress,
    });

    // 5. 接收发起方加密 bundle
    const peerBundleMessage = await readExpected(
      channel,
      "sync_bundle",
      config.readTimeoutMs,
      "等待对端 Changeset",
    );
    const peerBundle = decryptSyncPayload<P2PSyncBundle>(
      finalized.session,
      peerBundleMessage.payload,
    );

    // 6. 先发送本端 bundle（快照），再应用对端 bundle：避免把刚收到的行立刻回传
    const ownBundle = await buildOutgoingBundle(
      config,
      finalized.session.remoteDeviceId,
      this.sinceWatermark?.(finalized.session.remoteDeviceId),
    );
    const payload = encryptSyncPayload(finalized.session, ownBundle);
    await writeFrame(
      socket,
      { transportVersion: P2P_TRANSPORT_PROTOCOL_VERSION, kind: "sync_bundle", payload },
      writeOptions,
    );

    // 7. 应用对端 bundle（SyncPartialMergeError 原样上抛，保留 partialResult）
    const localMergeResult = await applyPeerBundle(config, peerBundle);

    // 8. 回执本端合并报告
    await writeFrame(
      socket,
      {
        transportVersion: P2P_TRANSPORT_PROTOCOL_VERSION,
        kind: "sync_result",
        mergeResult: localMergeResult,
      },
      writeOptions,
    );

    // 9. 读取对端回执：对端未回执即关闭时显式标记缺失
    const peerResult = await readPeerResultBestEffort(
      channel,
      config.ackTimeoutMs,
      config.onError,
      peerAddress,
    );

    return {
      role: "responder",
      localDeviceId: config.deviceId,
      peerDeviceId: finalized.session.remoteDeviceId,
      peerFingerprint: finalized.session.remoteFingerprint,
      sessionId: finalized.session.sessionId,
      sasCode: finalized.sasCode,
      localMergeResult,
      peerMergeResult: peerResult.result,
      peerResultMissing: peerResult.missing,
      partial: localMergeResult.partial || peerResult.result?.partial === true,
      peerAddress,
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }
}

/**
 * 读取对端合并回执：对端先关闭连接属**允许**的收尾顺序，此时返回 `missing: true`
 * 并让结果显式暴露；读取超时同样只上报不悬挂（绝不静默吞掉）。
 */
async function readPeerResultBestEffort(
  channel: FrameChannel,
  timeoutMs: number,
  onError: ((error: Error, context: { phase: string; peerAddress?: string }) => void) | undefined,
  peerAddress: string,
): Promise<{ result: SyncMergeResult | null; missing: boolean }> {
  try {
    const message = await readExpected(channel, "sync_result", timeoutMs, "等待对端合并回执");
    return { result: message.mergeResult, missing: false };
  } catch (error) {
    if (error instanceof P2PTransportError && error.code === "connection_closed") {
      return { result: null, missing: true };
    }
    const failure = error instanceof Error ? error : new Error(String(error));
    onError?.(failure, { phase: "ack", peerAddress });
    return { result: null, missing: true };
  }
}
