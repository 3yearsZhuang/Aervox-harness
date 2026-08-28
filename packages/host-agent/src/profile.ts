/**
 * Aervox｜思隅 @aervox/host-agent — 最小 Profile（阶段 4c，D2=B）
 *
 * Profile = LoopDriver 绑定 + ModelProvider 解析 + 单例锁文件。
 * 对齐 AVX-HAR-001 §3 Resolver 不变量：
 * - 每个 Profile 恰好解析一个 Loop Driver（native/replay/…），一个 Driver 恰好绑定一个 ModelProvider；
 * - 不安装 DSH/pi 时原生 Profile 仍可运行；禁止同时激活两个竞争性 Driver。
 *
 * 锁文件（<data>/profile-<id>.lock）防多实例同时接管同一执行队列：
 * 仅当持有者进程已退出（陈旧锁）时允许下一个 Host 接管；运行中进程持有期间拒绝重复激活。
 */

import { createOpenAICompatProvider, createReplayProvider } from "@aervox/agent-loop";
import type { ModelProviderPort, AdapterDriverPort } from "@aervox/agent-loop";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Driver 标识（AVX-HAR-001 §3 只读子集；DSH/pi 需已准入的进程外 Adapter） */
export type LoopDriverId = "native" | "replay" | "dsh" | "pi";

/** 已解析的 Driver→Provider/Adapter 绑定（最终候选） */
export interface ResolvedProfile {
  readonly profileId: string;
  readonly driver: LoopDriverId;
  /** native/replay 解析的模型 Provider（dsh/pi 经 adapter 执行整 Turn，不解析 Provider） */
  readonly provider?: ModelProviderPort;
  /** dsh/pi：已准入的进程外 Adapter Driver（整 Turn 代理执行） */
  readonly adapter?: AdapterDriverPort;
}

/** Provider 解析输入（最小配置面；llm 需真实模型配置，replay 无外部依赖） */
export interface ProfileProviderConfig {
  /** openai/deepseek/ollama/custom_openai 的 OpenAI 兼容端点 */
  baseUrl?: string;
  apiKey?: string;
  modelId?: string;
  temperature?: number;
  maxTokens?: number;
}

/** 锁文件路径提供者（可注入以便测试隔离） */
export interface LockFilePaths {
  /** 锁文件所在目录（默认 <cwd>/data） */
  dir?: string;
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export interface ProfileContract {
  /** 锁文件路径与持有者（PID + 时间戳） */
  lockFile(): string;
  acquire(): Promise<{ ok: true; release: () => Promise<void> } | { ok: false; reason: "already_locked" }>;
}

/**
 * 构造最小 Profile：按 driver 解析唯一 Provider（native/replay）或已准入 Adapter（dsh/pi），
 * 并绑定单例锁。
 *
 * - driver=replay：天然无外部依赖（AVX-HAR-001 §17 回退路径）；
 * - driver=native：ModelProvider 为 OpenAI 兼容流（createOpenAICompatProvider）；
 * - driver=dsh/pi：需 input.adapter（已准入的进程外 Adapter Driver；清单 adapterId 必须
 *   与 driver 一致，否则抛错）。未提供 adapter 时拒绝——与 ADR-010「不安装也完整可用」一致。
 */
export function createAgentProfile(input: {
  profileId: string;
  driver: LoopDriverId;
  config?: ProfileProviderConfig;
  /** dsh/pi：已准入的进程外 Adapter Driver（stdio handle 或模拟器） */
  adapter?: AdapterDriverPort;
  lockDir?: string;
}): { resolve(): ResolvedProfile; lock: ProfileContract } {
  const { profileId, driver, config = {}, adapter, lockDir } = input;

  const resolveProvider = (): ResolvedProfile => {
    if (driver === "replay") {
      return { profileId, driver, provider: createReplayProvider() };
    }
    if (driver === "native") {
      if (!config.baseUrl || !config.apiKey || !config.modelId) {
        throw new Error("native_profile_unconfigured: native Driver 需要 baseUrl/apiKey/modelId（同 CR-015 LLM 配置）");
      }
      return {
        profileId,
        driver,
        provider: createOpenAICompatProvider({
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          modelId: config.modelId,
          temperature: config.temperature,
          maxTokens: config.maxTokens,
        }),
      };
    }
    // DSH/pi：仅接受「已准入」的进程外 Adapter（TC-CONTRACT-STREAM-001 固定 SHA 复核在端口层完成）
    if (driver === "dsh" || driver === "pi") {
      if (!adapter) {
        throw new Error(
          `${driver}_profile_unconfigured: ${driver.toUpperCase()} Driver 需要已准入的进程外 Adapter（固定 SHA 复核），未安装时仅 native/replay 可用`,
        );
      }
      if (adapter.manifest.adapterId !== driver) {
        throw new Error(`driver_adapter_mismatch: driver=${driver} adapter=${adapter.manifest.adapterId}`);
      }
      return { profileId, driver, adapter };
    }
    throw new Error(`driver_unsupported: ${driver satisfies never}`);
  };

  const lockDirResolved = lockDir ?? join(process.cwd(), "data");
  const lockFile = (): string => join(lockDirResolved, `profile-${profileId}.lock`);
  const now = (): string => new Date().toISOString();

  const acquire = async (): Promise<{ ok: true; release: () => Promise<void> } | { ok: false; reason: "already_locked" }> => {
    mkdirSync(dirname(lockFile()), { recursive: true });
    // 陈旧锁接管：持有者进程已退出则删除重建
    try {
      const raw = readFileSync(lockFile(), "utf-8");
      const holder = JSON.parse(raw) as { pid: number; acquiredAt: string };
      if (Number.isInteger(holder.pid) && pidAlive(holder.pid)) {
        return { ok: false, reason: "already_locked" };
      }
      rmSync(lockFile(), { force: true });
    } catch {
      // 不存在或不可解析 → 视为可获取
    }
    writeFileSync(lockFile(), JSON.stringify({ pid: process.pid, acquiredAt: now() }, null, 2), "utf-8");
    return {
      ok: true,
      release: async () => {
        try {
          const raw = readFileSync(lockFile(), "utf-8");
          const holder = JSON.parse(raw) as { pid: number };
          if (holder.pid === process.pid) rmSync(lockFile(), { force: true });
        } catch {
          // 已被接管/删除：幂等
        }
      },
    };
  };

  return {
    resolve: (): ResolvedProfile => resolveProvider(),
    lock: { lockFile, acquire },
  };
}