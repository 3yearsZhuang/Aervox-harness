/**
 * Aervox｜思隅 @aervox/api — 插件端点装配的诊断契约（CR-060）
 *
 * 端点装配有三条不变量，本文件逐条锁定：
 * 1. **门控必填**：`isEnabled` 为必填参数，停用/未生效的插件端点一律 404，
 *    不存在"缺省即不设防"的调用形态；
 * 2. **诊断必填**：处理失败与非法路径跳过只经 `warn` 出口留痕——该出口一旦缺失，
 *    插件端点会静默返回 500，生产环境完全不可观测（曾由组合根漏传 `warn` 引发）；
 * 3. **挂载前校验路径**：非法路径在注册路由前被拒绝，避免 Fastify 注册中断宿主启动。
 *
 * 三者都是**编译期**契约（必填参数），本用例补充运行期证据。
 */
import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { PluginHostServices } from "@aervox/host-plugin-api";
import { mountPluginHttpEndpoints } from "../src/plugin-assembly.js";

/** 处理函数不使用宿主服务，故只需满足类型的最小替身 */
const services = () => ({}) as unknown as PluginHostServices;

describe("插件端点装配诊断（CR-060）", () => {
  it("端点处理失败时返回 500 并经 warn 留痕（不静默）", async () => {
    const app = Fastify();
    const warn = vi.fn();
    try {
      mountPluginHttpEndpoints(
        app,
        "probe-plugin",
        [
          {
            method: "GET",
            path: "/v1/probe/boom",
            handler: async () => {
              throw new Error("boom");
            },
          },
        ],
        services,
        async () => true,
        warn,
      );
      await app.ready();

      const res = await app.inject({ method: "GET", url: "/v1/probe/boom" });

      expect(res.statusCode).toBe(500);
      expect(warn).toHaveBeenCalledWith(
        "[plugin-assembly] 插件 probe-plugin 端点 /v1/probe/boom 处理失败",
        expect.any(Error),
      );
    } finally {
      await app.close();
    }
  });

  it("插件未生效时端点 404，不进入插件处理函数", async () => {
    const app = Fastify();
    const warn = vi.fn();
    const handler = vi.fn(async () => ({ payload: { ok: true } }));
    try {
      mountPluginHttpEndpoints(
        app,
        "probe-plugin",
        [{ method: "GET", path: "/v1/probe/gated", handler }],
        services,
        async () => false,
        warn,
      );
      await app.ready();

      const res = await app.inject({ method: "GET", url: "/v1/probe/gated" });

      expect(res.statusCode).toBe(404);
      expect(handler).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("非法路径在挂载前被拒绝并留痕，不注册任何路由", async () => {
    const app = Fastify();
    const warn = vi.fn();
    try {
      mountPluginHttpEndpoints(
        app,
        "probe-plugin",
        [
          { method: "GET", path: "/v1/probe/../escape", handler: async () => ({ payload: {} }) },
          { method: "GET", path: "/elsewhere/oops", handler: async () => ({ payload: {} }) },
        ],
        services,
        async () => true,
        warn,
      );
      await app.ready();

      expect(warn).toHaveBeenCalledTimes(2);
      expect(app.printRoutes()).not.toContain("escape");
      expect(app.printRoutes()).not.toContain("oops");
    } finally {
      await app.close();
    }
  });
});
