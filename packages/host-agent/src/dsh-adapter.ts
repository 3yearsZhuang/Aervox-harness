/**
 * Aervox｜思隅 @aervox/host-agent — DSH 真 Turn Adapter（阶段 6d）
 *
 * 组合：probeDSHReference（gitlink 固定 SHA + MIT 复核）→ createStdioAdapterDriver
 * （spawn `dsh-turn-runner.mjs`）。runner 为「协议 + 真实模型回合」接通骨架：
 * DEEPSEEK_API_KEY 或本地 OpenAI 兼容端点就绪时跑真实 LLM turn；缺前置返回
 * 指引性 error，host 失败自动禁用。就绪态探测仅对 SubagentPort 侧不阻塞。
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DSH_REFERENCE_SHA, probeDSHReference, type DSHReferenceProbeResult } from "./dsh-reference.js";
import { createStdioAdapterDriver } from "./stdio-adapter.js";
import type { StdioAdapterDriverHandle } from "./stdio-adapter.js";

export interface DSHAdapterOptions {
  /** 仓库根（含 reference/deepseek-harness 子模块） */
  repoRoot?: string;
  /** 单 Turn 总超时（缺省 30s：真实模型回合） */
  requestTimeoutMs?: number;
  /** 透传给 runner 的环境（如 DSH_LLM_BASE_URL 指向本地兼容端点） */
  env?: Record<string, string>;
}

export interface DSHAdapterResult {
  /** 准入复核（gitlink SHA + MIT；ready=false 时给出 reason） */
  probe: DSHReferenceProbeResult;
  /** 已准入时返回 stdio handle；probe 未就绪则为 undefined（调用方可报失败） */
  handle?: StdioAdapterDriverHandle;
}

const runnerPath = join(fileURLToPath(new URL("../test/fixtures/dsh-turn-runner.mjs", import.meta.url)));

/**
 * 构造 DSH Adapter：先做固定 SHA 复核，通过后 spawn runner（stdio JSON 行）。
 * probe 未就绪（submodule 缺失/SHA 漂移/许可证拒绝）时不 spawn，返回 reason。
 */
export async function createDSHAdapterDriver(options: DSHAdapterOptions = {}): Promise<DSHAdapterResult> {
  const repoRoot = options.repoRoot ?? process.cwd();
  const probe = probeDSHReference(repoRoot);
  if (!probe.ready || !probe.manifest) {
    return { probe };
  }
  const handle = await createStdioAdapterDriver({
    command: process.execPath,
    args: [runnerPath],
    env: options.env,
    expected: { adapterId: "dsh", sha256: DSH_REFERENCE_SHA },
    requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
  });
  return { probe, handle };
}