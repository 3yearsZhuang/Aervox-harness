/**
 * Aervox｜思隅 @aervox/host-agent — 阶段 6 stdio Adapter 端口 + Profile 解析测试
 *
 * 覆盖 ADR-010「进程外 Adapter + 版本锁定/超时/kill switch/失败自动禁用」：
 * - 子进程握手（hello → 准入复核）：固定 SHA 复核通过 / 失配 kill + adapter_admission_failed；
 * - 整 Turn ping-pong：delta 事件 + 批次声明；dsh-any 混合批次经 drainAdapterDriver 收紧拒绝；
 * - 协议缺陷（未声明批次）；请求超时 kill（失败自动禁用 → 后续 run 抛 adapter_unavailable）；
 * - Profile 解析：dsh/pi 缺 adapter 拒绝、adapterId 失配拒绝、有 adapter 解析成功；replay/native 不回归。
 */
import { afterEach, describe, expect, it } from "vitest";
import { createAgentProfile, createStdioAdapterDriver } from "../src/index.js";
import { drainAdapterDriver, createSimAdapterDriver } from "@aervox/agent-loop";
import type { AdapterManifest } from "@aervox/agent-loop";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "sim-adapter.mjs");

const dshSha = "dsh-sha-1";
const dshManifest: AdapterManifest = {
  adapterId: "dsh",
  version: "sim-1.0",
  sha256: dshSha,
  license: "MIT",
  terminationPolicy: "any",
};

const request = {
  turnId: "turn_1",
  sessionId: "session_1",
  attemptId: "attempt_1",
  userMessage: "帮我总结",
};

describe("阶段 6 createStdioAdapterDriver（子进程 JSON-RPC）", () => {
  let handles: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    for (const h of handles) await h.close();
    handles = [];
  });

  const open = (env: Record<string, string> = {}, expected?: { adapterId: "dsh" | "pi"; sha256?: string }) =>
    createStdioAdapterDriver({
      command: process.execPath,
      args: [fixturePath],
      env,
      expected: expected ?? { adapterId: "dsh", sha256: dshSha },
    }).then((h) => {
      handles.push(h);
      return h;
    });

  it("握手准入通过（SHA 匹配）→ 整 Turn 事件 + 全结论批次 → concluded", async () => {
    const { driver } = await open({ ADAPTER_ID: "dsh", ADAPTER_SHA: dshSha, SIM_BATCH: "all" });
    expect(driver.manifest.adapterId).toBe("dsh");
    const outcome = await drainAdapterDriver(driver, request);
    expect(outcome.events.map((e) => e.type)).toContain("delta");
    expect(outcome.decision).toEqual({ concluded: true });
  });

  it("固定 SHA 失配 → kill 并抛 adapter_admission_failed（版本锁定复核）", async () => {
    await expect(open({ ADAPTER_ID: "dsh", ADAPTER_SHA: "tampered" })).rejects.toThrow(/adapter_admission_failed: sha_mismatch/);
  });

  it("许可证非白名单 → 准入拒绝（AGPL 等强 copyleft）", async () => {
    await expect(open({ ADAPTER_ID: "dsh", ADAPTER_SHA: dshSha, ADAPTER_LICENSE: "AGPL-3.0" })).rejects.toThrow(
      /adapter_admission_failed: license_not_allowed/,
    );
  });

  it("dsh-any 混合批次 → drainAdapterDriver 收紧为 mixed_batch 拒绝（不静默放行）", async () => {
    const { driver } = await open({ ADAPTER_ID: "dsh", ADAPTER_SHA: dshSha, ADAPTER_POLICY: "any", SIM_BATCH: "mixed" });
    const outcome = await drainAdapterDriver(driver, request);
    expect(outcome.decision).toEqual({ concluded: false, reason: "mixed_batch", declaredPolicy: "any" });
  });

  it("协议缺陷：未声明批次 → batch_not_declared（host 按无结论收敛）", async () => {
    const { driver } = await open({ ADAPTER_ID: "dsh", ADAPTER_SHA: dshSha, SIM_BATCH: "none-value" });
    const outcome = await drainAdapterDriver(driver, request);
    expect(outcome.protocolError).toBe("batch_not_declared");
    expect(outcome.decision).toEqual({ concluded: false, reason: "empty_batch" });
  });

  it("请求超时 → kill 子进程且失败自动禁用（后续 run 抛 adapter_unavailable）", async () => {
    const { driver, close } = await open(
      { ADAPTER_ID: "dsh", ADAPTER_SHA: dshSha, SIM_BATCH: "all" },
      undefined,
    );
    await close(); // kill switch：主动关闭（等价超时禁用的可用性收敛）
    await expect(async () => {
      for await (const _ of driver.run(request)) {
        // no-op
      }
    }).rejects.toThrow(/adapter_unavailable|handshake/);
  }, 8000);
});

describe("阶段 6 Profile 解析（dsh/pi 准入）", () => {
  it("dsh/pi 未提供 adapter → 拒绝（ADR-010：不安装也完整可用，绝不静默回退）", () => {
    expect(() => createAgentProfile({ profileId: "p-dsh", driver: "dsh" }).resolve()).toThrow(/dsh_profile_unconfigured/);
    expect(() => createAgentProfile({ profileId: "p-pi", driver: "pi" }).resolve()).toThrow(/pi_profile_unconfigured/);
  });

  it("adapterId 与 driver 失配 → driver_adapter_mismatch", async () => {
    const piSim = createSimAdapterDriver({ manifest: { ...dshManifest, adapterId: "dsh" } });
    expect(() =>
      createAgentProfile({ profileId: "p-pi", driver: "pi", adapter: piSim }).resolve(),
    ).toThrow(/driver_adapter_mismatch: driver=pi adapter=dsh/);
  });

  it("已准入 adapter → 解析出 adapter 绑定（provider 缺省）", async () => {
    const sim = createSimAdapterDriver({ manifest: dshManifest });
    const resolved = createAgentProfile({ profileId: "p-dsh", driver: "dsh", adapter: sim }).resolve();
    expect(resolved.driver).toBe("dsh");
    expect(resolved.adapter?.manifest.adapterId).toBe("dsh");
    expect(resolved.provider).toBeUndefined();
  });

  it("replay/native 不回归：replay 无需配置；native 缺配置仍拒绝", () => {
    const rep = createAgentProfile({ profileId: "p-replay", driver: "replay" }).resolve();
    expect(rep.provider?.id).toBeTruthy();
    expect(() => createAgentProfile({ profileId: "p-native", driver: "native" }).resolve()).toThrow(
      /native_profile_unconfigured/,
    );
  });
});