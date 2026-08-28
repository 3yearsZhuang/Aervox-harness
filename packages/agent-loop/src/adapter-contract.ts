/**
 * Aervox｜思隅 @aervox/agent-loop — DSH/pi 进程外 Adapter 契约（阶段 6）
 *
 * 规则依据：ADR-010（DSH/pi 仅为可选适配器；Aervox 数据唯一真源）与
 * reference-design-transfer §1.1（DSH-01/PI-01 固定 commit、MIT 可参考；
 * 「DSH 任一成功即 concludesTurn（any）/ pi 非空批次全部 terminate（every）」
 * 的终止语义差异——Aervox 统一采用严格（every）策略，混合批次拒绝、不静默放行）。
 *
 * 本文件只定义契约与纯函数（收敛判定 / 清单准入 / 线协议），无系统 IO：
 * - AdapterDriverPort：外部 Agent 运行时（整 Turn 执行）的最小 Driver 面；
 * - concludeAdapterBatch：把上游 any/every 批次声明收紧为 Aervox `all-results-conclude`；
 * - verifyAdapterManifest：TC-CONTRACT-STREAM-001 的固定 SHA + 许可证 + 策略准入复核；
 * - AdapterWireMessage + 编解码：子进程 stdio 与内存模拟器共用的 JSON 行协议。
 */
import type { ToolSpec } from "./types.js";

/** Adapter 标识（阶段 6 仅 DSH/pi；DSH=DeepSeek Harness） */
export type AdapterDriverId = "dsh" | "pi";

/**
 * 终止语义声明（reference-design-transfer §1.1）：
 * - `any`：DSH 原语义——任一成功结果即可声明 concludesTurn；
 * - `every`：pi 原语义——非空批次所有结果 terminate=true 才收敛（= Aervox 严格策略）。
 * Aervox host 一律按严格语义收紧：混合批次拒绝，any 声明不被静默放行。
 */
export type AdapterTerminationPolicy = "any" | "every";

/** 适配器准入清单（TC-CONTRACT-STREAM-001：固定 SHA 复核 + 许可证 + 策略） */
export interface AdapterManifest {
  adapterId: AdapterDriverId;
  version: string;
  /** 固定 reference commit/产物 SHA（版本锁定的机器复核键） */
  sha256: string;
  /** 许可证（仅白名单允许；AGPL 等一律拒绝，ADR-010） */
  license: string;
  /** 上游声明语义；host 统一按 every（严格）收紧 */
  terminationPolicy: AdapterTerminationPolicy;
}

/** 一个已结算工具批次的结束声明（模拟 DSH any / pi every 的差异面） */
export interface AdapterBatchDeclaration {
  /** 每个已结算结果是否声明结束 */
  concludes: boolean[];
}

/** Adapter → Aervox 的事件流（整 Turn 执行；host 以此重建审计并收紧终态） */
export type AdapterEvent =
  | { type: "delta"; text: string }
  | { type: "tool_request"; invocationId: string; name: string; arguments: unknown }
  | { type: "tool_result"; invocationId: string; ok: boolean; output?: unknown; error?: string }
  | { type: "batch"; concludes: boolean[] };

/** Adapter 整 Turn 请求（host 构造；上下文仅 user 输入 + 工具集，历史组装由 host 侧 ContextBuilder 负责） */
export interface AdapterRequest {
  turnId: string;
  sessionId: string;
  attemptId: string;
  userMessage: string;
  tools?: ToolSpec[];
}

/** 进程外 Adapter Driver（Host 持有实现；子进程 stdio / 内存模拟器双实现） */
export interface AdapterDriverPort {
  readonly id: AdapterDriverId;
  readonly manifest: AdapterManifest;
  /** 执行整个 Turn，产出事件流（含批次声明）；失败/超时以 throw 或 error 终止 */
  run(request: AdapterRequest): AsyncIterable<AdapterEvent> | Promise<AsyncIterable<AdapterEvent>>;
}

/** 批次收敛判定（Aervox `all-results-conclude` 收紧结果） */
export type BatchConcludeDecision =
  | { concluded: true }
  | { concluded: false; reason: "empty_batch" }
  | { concluded: false; reason: "none_concluded" }
  | { concluded: false; reason: "mixed_batch"; declaredPolicy: AdapterTerminationPolicy };

/**
 * 批次收敛（纯函数）：把上游 any/every 声明收紧为 Aervox `all-results-conclude`。
 * - 空批次：不结论（host 按无结论收敛）；
 * - 全部结论：收敛（两种上游语义均接受）；
 * - 全不结论：不收敛（继续或由 host 预算收敛）；
 * - 混合批次：Aervox 统一严格策略一律拒绝（不静默放行 any 声明），并回传上游声明策略供审计。
 */
export function concludeAdapterBatch(
  declaredPolicy: AdapterTerminationPolicy,
  declaration: AdapterBatchDeclaration,
): BatchConcludeDecision {
  if (declaration.concludes.length === 0) return { concluded: false, reason: "empty_batch" };
  const allTrue = declaration.concludes.every(Boolean);
  const someTrue = declaration.concludes.some(Boolean);
  if (allTrue) return { concluded: true };
  if (!someTrue) return { concluded: false, reason: "none_concluded" };
  return { concluded: false, reason: "mixed_batch", declaredPolicy };
}

/** 适配器许可证白名单（ADR-010：AGPL 等强 copyleft 未经许可不得进入核心服务） */
export const ALLOWED_ADAPTER_LICENSES: readonly string[] = ["MIT", "Apache-2.0", "BSD-3-Clause", "BSD-2-Clause"];

/** 清单准入结果（TC-CONTRACT-STREAM-001 固定 SHA 复核 / TC-PRIV 许可面） */
export interface AdapterManifestVerification {
  ok: boolean;
  error?:
    | "adapter_id_mismatch"
    | "sha_mismatch"
    | "license_not_allowed"
    | "policy_not_supported";
  /** 通过时为 manifest 副本（供 Profile 绑定与审计留痕） */
  manifest?: AdapterManifest;
}

/**
 * 适配器准入复核（纯函数）：
 * - expectedSha 与 manifest.sha256 固定 SHA 复核（版本锁定）；
 * - 许可证白名单校验（AGPL 等拒绝，ADR-010）；
 * - 终止策略仅接受 any/every（any 由 host 收紧，不在此拒绝）。
 */
export function verifyAdapterManifest(
  manifest: AdapterManifest,
  expected: { adapterId?: AdapterDriverId; sha256?: string } = {},
): AdapterManifestVerification {
  if (expected.adapterId && manifest.adapterId !== expected.adapterId) {
    return { ok: false, error: "adapter_id_mismatch" };
  }
  if (expected.sha256 && manifest.sha256 !== expected.sha256) {
    return { ok: false, error: "sha_mismatch" };
  }
  if (!ALLOWED_ADAPTER_LICENSES.includes(manifest.license)) {
    return { ok: false, error: "license_not_allowed" };
  }
  if (manifest.terminationPolicy !== "any" && manifest.terminationPolicy !== "every") {
    return { ok: false, error: "policy_not_supported" };
  }
  return { ok: true, manifest };
}

/** JSON 行协议（子进程 stdio 与内存模拟器共用同一线格式） */
export type AdapterWireMessage =
  | { kind: "hello"; manifest: AdapterManifest }
  | { kind: "request"; id: string; request: AdapterRequest }
  | { kind: "event"; id: string; event: AdapterEvent }
  | { kind: "batch"; id: string; concludes: boolean[] }
  | { kind: "done"; id: string }
  | { kind: "error"; id: string; message: string };

/** 编码为单行 JSON（stdio 协议载荷） */
export function encodeAdapterLine(message: AdapterWireMessage): string {
  return JSON.stringify(message);
}

/** 解码单行 JSON（shape 白名单校验；非法行抛错由调用方按协议违约处理） */
export function decodeAdapterLine(line: string): AdapterWireMessage {
  const parsed = JSON.parse(line) as AdapterWireMessage;
  if (typeof parsed !== "object" || parsed === null || typeof (parsed as { kind?: string }).kind !== "string") {
    throw new Error("adapter_protocol_invalid: missing kind");
  }
  switch (parsed.kind) {
    case "hello": {
      const m = (parsed as { manifest?: unknown }).manifest as Partial<AdapterManifest> | undefined;
      if (!m || typeof m.adapterId !== "string" || typeof m.version !== "string" || typeof m.sha256 !== "string") {
        throw new Error("adapter_protocol_invalid: hello.manifest");
      }
      return parsed as AdapterWireMessage;
    }
    case "request": {
      const r = (parsed as { request?: unknown }).request as Partial<AdapterRequest> | undefined;
      if (!r || typeof r.turnId !== "string" || typeof r.sessionId !== "string" || typeof r.userMessage !== "string") {
        throw new Error("adapter_protocol_invalid: request");
      }
      return parsed as AdapterWireMessage;
    }
    case "event": {
      const e = (parsed as { event?: unknown }).event as Partial<AdapterEvent> | undefined;
      if (!e || typeof (e as { type?: string }).type !== "string") {
        throw new Error("adapter_protocol_invalid: event");
      }
      return parsed as AdapterWireMessage;
    }
    case "batch": {
      const c = (parsed as { concludes?: unknown }).concludes;
      if (!Array.isArray(c) || !c.every((x) => typeof x === "boolean")) {
        throw new Error("adapter_protocol_invalid: batch.concludes");
      }
      return parsed as AdapterWireMessage;
    }
    case "done":
    case "error":
      return parsed as AdapterWireMessage;
    default:
      throw new Error(`adapter_protocol_invalid: unknown kind "${(parsed as { kind?: string }).kind}"`);
  }
}