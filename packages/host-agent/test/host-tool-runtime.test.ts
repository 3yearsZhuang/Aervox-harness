import { describe, expect, it, vi } from "vitest";
import {
  HostToolRuntime,
  InMemoryToolRegistry,
  defaultGatingEvaluator,
  type HostToolDefinition,
  type HostToolHandler,
} from "../src/index.js";
import { ControlContext } from "@aervox/agent-loop";

const ctx = { workspaceId: "local", subjectUserId: "local" } as const;

const def = (safetyLevel = "read_only", name = "test"): HostToolDefinition => ({
  id: name,
  name,
  category: "system",
  description: "test fixture",
  safetyLevel,
});

describe("HostToolRuntime (packages/host-agent)", () => {
  it("默认使用纯内存 InMemoryToolRegistry 独立构造与执行工具，零数据库依赖", async () => {
    const runtime = new HostToolRuntime();
    const handler: HostToolHandler = {
      call: async (_ctx, args) => ({ result: (args as { x: number }).x * 2 }),
    };

    const release = await runtime.registerContribution(def("read_only", "double"), handler);
    const tools = await runtime.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("double");

    const out = await runtime.callTool(ctx, "double", { x: 21 });
    expect(out).toEqual({ result: 42 });

    release();
    expect(await runtime.exportRegistry()).toEqual([]);
  });

  it("写工具（write_with_approval）在无 approval=true 时强制拒绝 (fail-closed)", async () => {
    const runtime = new HostToolRuntime();
    const handler: HostToolHandler = {
      call: async () => "written",
    };

    await runtime.registerContribution(def("write_with_approval", "save"), handler);

    // 未授权调用被拦截
    await expect(runtime.callTool(ctx, "save", {})).rejects.toThrow("approval");

    // 授权调用放行
    const out = await runtime.callTool(ctx, "save", {}, { approval: true });
    expect(out).toBe("written");
  });

  it("参数沙箱防线：路径穿越与非法注入直接拒绝且不触发 handler", async () => {
    const runtime = new HostToolRuntime();
    const handler = { call: vi.fn(async () => "ok") };

    await runtime.registerContribution(def("read_only", "read_file"), handler);

    // 路径穿越注入
    await expect(runtime.callTool(ctx, "read_file", { path: "../../etc/shadow" })).rejects.toThrow(
      "unsafe tool arguments",
    );
    expect(handler.call).not.toHaveBeenCalled();

    // 空字节注入
    await expect(runtime.callTool(ctx, "read_file", { path: "hello\0world" })).rejects.toThrow(
      "unsafe tool arguments",
    );
    expect(handler.call).not.toHaveBeenCalled();
  });

  it("代际保护（Generation Protection）：外部篡改工具元数据导致旧 handler 失效", async () => {
    const runtime = new HostToolRuntime();
    const writeHandler = vi.fn(async () => "privileged_action");

    await runtime.registerContribution(def("write_with_approval", "target"), { call: writeHandler });
    // 外部修改工具元数据为 read_only
    await runtime.registerTool(def("read_only", "target"));

    // 旧 handler 命中代际变更检测，拒绝执行
    await expect(runtime.callTool(ctx, "target", {})).rejects.toThrow("definition changed");
    expect(writeHandler).not.toHaveBeenCalled();
  });

  it("支持级联 AbortSignal 与 ControlContext 超时/取消", async () => {
    const runtime = new HostToolRuntime();
    let resolveStarted!: (sig: AbortSignal) => void;
    const started = new Promise<AbortSignal>((r) => (resolveStarted = r));

    await runtime.registerContribution(def("read_only", "slow"), {
      call: async (_ctx, _args, context) => {
        resolveStarted(context.signal);
        await new Promise<void>((resolve) => {
          context.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return "aborted_or_finished";
      },
    });

    const control = new ControlContext({
      turnId: "t1",
      attemptId: "a1",
      sessionId: "s1",
      deadlineEpochMs: Date.now() + 5000,
    });

    const callPromise = runtime.callTool(ctx, "slow", {}, { controlContext: control });
    const receivedSignal = await started;
    control.abort("manual_test_abort");

    await expect(callPromise).rejects.toThrow("expired");
    expect(receivedSignal.aborted).toBe(true);
    control.dispose();
  });

  it("dispose 后无法再注册或调用工具", async () => {
    const runtime = new HostToolRuntime();
    await runtime.registerContribution(def(), { call: async () => 1 });
    runtime.dispose();

    await expect(runtime.registerContribution(def("read_only", "other"), { call: async () => 2 })).rejects.toThrow(
      "disposed",
    );
    await expect(runtime.callTool(ctx, "test", {})).rejects.toThrow("disposed");
  });

  it("AST-04 调用时门禁求值：条件不满足或上下文缺失 fail-closed，满足则放行", async () => {
    const runtime = new HostToolRuntime();
    const handler = vi.fn(async () => "gated_ok");

    await runtime.registerContribution(
      { ...def("read_only", "gated"), gatingConditions: [{ field: "profile.tier", operator: "equals", value: "pro" }] },
      handler,
    );

    // 未提供门禁上下文 → 字段解析失败 → 拒绝（直呼工具 ID 无法绕过列表过滤）
    await expect(runtime.callTool(ctx, "gated", {})).rejects.toThrow("tool gated");
    expect(handler).not.toHaveBeenCalled();

    // 条件不满足 → 拒绝
    await expect(
      runtime.callTool(ctx, "gated", {}, { gatingContext: { profile: { tier: "free" } } }),
    ).rejects.toThrow("tool gated");
    expect(handler).not.toHaveBeenCalled();

    // 条件满足 → 放行
    await expect(
      runtime.callTool(ctx, "gated", {}, { gatingContext: { profile: { tier: "pro" } } }),
    ).resolves.toBe("gated_ok");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("AST-04 门禁求值：未知算子 fail-closed，无条件工具不受影响", async () => {
    const runtime = new HostToolRuntime();
    await runtime.registerContribution(
      { ...def("read_only", "weird_gate"), gatingConditions: [{ field: "x", operator: "regex", value: ".*" }] },
      { call: async () => "ok" },
    );
    await runtime.registerContribution(def("read_only", "ungated"), { call: async () => "ok" });

    await expect(runtime.callTool(ctx, "weird_gate", {})).rejects.toThrow("tool gated");
    await expect(runtime.callTool(ctx, "ungated", {})).resolves.toBe("ok");
  });

  it("InMemoryToolRegistry.exportRegistry 门控过滤与 SQLite 仓储语义对齐", async () => {
    const registry = new InMemoryToolRegistry();
    await registry.registerTool({ ...def("read_only", "visible"), gatingConditions: [] });
    await registry.registerTool({
      ...def("read_only", "hidden"),
      gatingConditions: [{ field: "tier", operator: "equals", value: "pro" }],
    });

    const listedPro = await registry.exportRegistry({
      gatingEvaluator: (condition) => defaultGatingEvaluator(condition, { tier: "pro" }),
      gatingContext: { tier: "pro" },
    });
    expect(listedPro.map((t) => t.name)).toContain("visible");
    expect(listedPro.map((t) => t.name)).toContain("hidden");

    const listedFree = await registry.exportRegistry({
      gatingEvaluator: (condition) => defaultGatingEvaluator(condition, { tier: "free" }),
      gatingContext: { tier: "free" },
    });
    expect(listedFree.map((t) => t.name)).toContain("visible");
    expect(listedFree.map((t) => t.name)).not.toContain("hidden");
  });
});
