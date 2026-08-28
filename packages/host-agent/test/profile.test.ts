/**
 * Aervox｜思隅 @aervox/host-agent — 最小 Profile 测试（阶段 4c，D2=B）
 *
 * 覆盖：Driver→Provider 绑定（replay 无依赖 / native 需配置）、锁文件单例
 * （持有者存活拒绝 / 陈旧锁接管 / 释放后重新可获取）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentProfile } from "../src/index.js";

let dirs: string[] = [];

const freshLockDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "aervox-profile-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("最小 Profile（createAgentProfile）", () => {
  it("replay Driver：无需外部配置即可解析 Provider，锁文件可获取", async () => {
    const lockDir = freshLockDir();
    const profile = createAgentProfile({ profileId: "native", driver: "replay", lockDir });
    const resolved = profile.resolve();
    expect(resolved.profileId).toBe("native");
    expect(resolved.driver).toBe("replay");
    expect(typeof resolved.provider.stream).toBe("function");

    const acquired = await profile.lock.acquire();
    expect(acquired.ok).toBe(true);
    // 持有者写入 PID
    const raw = JSON.parse(readFileSync(profile.lock.lockFile(), "utf-8")) as { pid: number };
    expect(raw.pid).toBe(process.pid);
  });

  it("单例锁：持有者存活时第二次 acquire 拒绝（already_locked）", async () => {
    const lockDir = freshLockDir();
    const profileA = createAgentProfile({ profileId: "dual", driver: "replay", lockDir });
    const profileB = createAgentProfile({ profileId: "dual", driver: "replay", lockDir });
    const first = await profileA.lock.acquire();
    expect(first.ok).toBe(true);

    const second = await profileB.lock.acquire();
    expect(second).toEqual({ ok: false, reason: "already_locked" });
  });

  it("释放后重新可获取（同类 Profile 二次启动）", async () => {
    const lockDir = freshLockDir();
    const profile = createAgentProfile({ profileId: "cyclic", driver: "replay", lockDir });
    const first = await profile.lock.acquire();
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await first.release();

    const again = await profile.lock.acquire();
    expect(again.ok).toBe(true);
  });

  it("陈旧锁接管：持有者 PID 已不存在 → 新 Host 可获取并覆盖", async () => {
    const lockDir = freshLockDir();
    const profile = createAgentProfile({ profileId: "stale", driver: "replay", lockDir });
    // 伪造一个已退出进程持有的锁（PID 999999 大概率不存在；如恰好存在则以自杀式死循环换取确定性）
    writeFileSync(profile.lock.lockFile(), JSON.stringify({ pid: 999_999_999, acquiredAt: new Date(0).toISOString() }), "utf-8");

    const acquired = await profile.lock.acquire();
    expect(acquired.ok).toBe(true);
    const raw = JSON.parse(readFileSync(profile.lock.lockFile(), "utf-8")) as { pid: number };
    expect(raw.pid).toBe(process.pid);
  });

  it("native Driver：缺少 baseUrl/apiKey/modelId → 解析抛错（与 CR-015 配置对齐）", () => {
    const profile = createAgentProfile({ profileId: "native", driver: "native", config: {}, lockDir: freshLockDir() });
    expect(() => profile.resolve()).toThrow(/native_profile_unconfigured/);
  });

  it("native Driver：配置齐全 → 解析出 OpenAI 兼容 Provider（不发起连接）", () => {
    const profile = createAgentProfile({
      profileId: "native",
      driver: "native",
      config: { baseUrl: "https://api.example.com/v1", apiKey: "sk-test", modelId: "deepseek-chat" },
      lockDir: freshLockDir(),
    });
    const resolved = profile.resolve();
    expect(resolved.driver).toBe("native");
    expect(resolved.provider.id).toBeTruthy();
  });
});