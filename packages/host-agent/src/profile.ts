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
import type { ModelProviderPort } from "@aervox/agent-loop";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Driver 标识（AVX-HAR-001 §3 只读子集；DSH/pi 未准入） */
export type LoopDriverId = "native" | "replay";

/** 已解析的 Driver→Provider 绑定（最终候选） */
export interface ResolvedProfile {
  readonly profileId: string;
  readonly driver: LoopDriverId;
  readonly provider: ModelProviderPort;
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
 * 构造最小 Profile：按 driver 解析唯一 Provider，并绑定单例锁。
 *
 * - driver=replay：天然无外部依赖（AVX-HAR-001 §17 回退路径）；
 * - driver=native：本阶段 ModelProvider 仍为 OpenAI 兼容流（createOpenAICompatProvider）；
 *   DSH/pi 未完成进程外 Adapter 前一律拒绝（resolveProvider 抛错）。
 */
export function createAgentProfile(input: {
  profileId: string;
  driver: LoopDriverId;
  config?: ProfileProviderConfig;
  lockDir?: string;
}): { resolve(): ResolvedProfile; lock: ProfileContract } {
  const { profileId, driver, config = {}, lockDir } = input;

  const resolveProvider = (): ModelProviderPort => {
    if (driver === "replay") return createReplayProvider();
    if (driver === "native") {
      if (!config.baseUrl || !config.apiKey || !config.modelId) {
        throw new Error("native_profile_unconfigured: native Driver 需要 baseUrl/apiKey/modelId（同 CR-015 LLM 配置）");
      }
      return createOpenAICompatProvider({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        modelId: config.modelId,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
      });
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
    resolve: (): ResolvedProfile => ({ profileId, driver, provider: resolveProvider() }),
    lock: { lockFile, acquire },
  };
}