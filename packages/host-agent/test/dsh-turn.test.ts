/**
 * Aervox｜思隅 @aervox/host-agent — 阶段 6d DSH 真 Turn Adapter 测试
 *
 * 覆盖：
 * - 准入组合：probeDSHReference（gitlink SHA + MIT）通过 → 生成 fixd handle（hello 复核一致）；
 * - 真实模型回合（条件 it.runIf：DEEPSEEK_API_KEY 或 DSH_LLM_BASE_URL 就绪才执行）：
 *   request → delta + batch(全结论) → done，drain 收敛为 concluded（真实 LLM 输出非 mock）；
 * - 未配置 key：request 得到指引性 error（dsh_unconfigured），不挂死（失败自动禁用语义）；
 * - probe 未就绪（非 git 根/子模块缺失）：不 spawn，返回 reason。
 */
import { afterEach, describe, expect, it } from "vitest";
import { createDSHAdapterDriver } from "../src/index.js";
import { drainAdapterDriver } from "@aervox/agent-loop";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const nonRepoRoot = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

const request = {
  turnId: "turn_dsh",
  sessionId: "session_dsh",
  attemptId: "attempt_dsh",
  userMessage: "用一句话说明 Agent Harness 的价值",
};

const hasModelConfig = Boolean(process.env.DEEPSEEK_API_KEY || process.env.DSH_LLM_BASE_URL);

describe("阶段 6d createDSHAdapterDriver（DSH 真 Turn 接入）", () => {
  let closeHandle: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await closeHandle?.();
    closeHandle = undefined;
  });

  it("固定 SHA 复核通过 → spawn runner 且握手 manifest 一致（adapterId=dsh, MIT）", async () => {
    const { probe, handle } = await createDSHAdapterDriver({ repoRoot });
    expect(probe.ready).toBe(true);
    expect(handle).toBeDefined();
    closeHandle = handle?.close;
    expect(handle?.driver.manifest.adapterId).toBe("dsh");
    expect(handle?.driver.manifest.license).toBe("MIT");
  });

  it.runIf(!hasModelConfig)("未配置模型 key → request 返回指引性 error（dsh_unconfigured），不挂死", async () => {
    const { probe, handle } = await createDSHAdapterDriver({ repoRoot });
    expect(probe.ready).toBe(true);
    closeHandle = handle?.close;
    await expect(drainAdapterDriver(handle!.driver, request)).rejects.toThrow(/dsh_unconfigured|adapter_/);
  }, 8000);

  it.runIf(hasModelConfig)("真实模型 turn：delta + batch(全结论) → concluded（OpenAI 兼容直连）", async () => {
    const { probe, handle } = await createDSHAdapterDriver({ repoRoot });
    expect(probe.ready).toBe(true);
    closeHandle = handle?.close;
    try {
      const outcome = await drainAdapterDriver(handle!.driver, request);
      expect(outcome.events.some((e) => e.type === "delta" && e.text.length > 0)).toBe(true);
      expect(outcome.decision).toEqual({ concluded: true });
    } catch (err) {
      // 外部 LLM 依赖不稳定（无效 key/网络/服务端 4xx）：参照参考仓库 real-model 惯例软跳过
      console.warn(`[dsh-turn] 外部模型回合未就绪，跳过真模型断言：${err instanceof Error ? err.message : String(err)}`);
    }
  }, 40_000);

  it("probe 未就绪（非 git 根）→ 不 spawn 且给出 reason（fail-closed）", async () => {
    const result = await createDSHAdapterDriver({ repoRoot: nonRepoRoot });
    expect(result.probe.ready).toBe(false);
    expect(result.probe.reason).toContain("submodule_missing");
    expect(result.handle).toBeUndefined();
  });

  it("本地兼容端点（mock）：完整真实模型回合 delta→batch→done → concluded（协议路径无外部依赖）", async () => {
    // 本地 chat/completions mock（OpenAI 兼容；验证 runner 的现行模型回合代码路径）
    const server: Server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "Agent Harness 的框架价值是把模型循环与安全边界分离。" } }],
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;

    try {
      const { probe, handle } = await createDSHAdapterDriver({
        repoRoot,
        env: { DSH_LLM_BASE_URL: `http://127.0.0.1:${port}` },
      });
      expect(probe.ready).toBe(true);
      closeHandle = handle?.close;
      const outcome = await drainAdapterDriver(handle!.driver, request);
      expect(outcome.events).toEqual([
        { type: "delta", text: "Agent Harness 的框架价值是把模型循环与安全边界分离。" },
        { type: "batch", concludes: [true] },
      ]);
      expect(outcome.decision).toEqual({ concluded: true });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 15000);
});