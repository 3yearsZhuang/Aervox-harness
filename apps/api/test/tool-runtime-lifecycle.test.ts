import { describe, expect, it, vi } from "vitest";
import { ToolRuntime, type ToolRegistryPort, type ToolDefinition } from "../src/modules/ecosystem/tools/index.js";
import { contributeMemoryTool } from "../src/modules/companion/memory/tool-contribution.js";
import type { ToolRegistrationModel } from "@aervox/repositories";

const ctx = { workspaceId: "local", subjectUserId: "local" } as const;
function fixture() {
  const rows = new Map<string, ToolRegistrationModel>();
  const registry: ToolRegistryPort = {
    registerTool: async (d) => {
      const row = { ...d, enabled: rows.get(d.id)?.enabled ?? 1, safetyLevel: d.safetyLevel ?? "write_with_approval", builtin: d.builtin ? 1 : 0,
        inputSchemaJson: d.inputSchema, requiredPermissionsJson: d.requiredPermissions,
        gatingConditionsJson: d.gatingConditions, replay: d.replay ?? null, pluginId: d.pluginId ?? null,
      } as ToolRegistrationModel;
      rows.set(d.id, row); return row;
    },
    getTool: async (id) => rows.get(id) ?? null,
    listTools: async () => [...rows.values()],
    exportRegistry: async () => [...rows.values()].filter((r) => r.enabled === 1),
    setEnabled: async (id, enabled) => { const r = rows.get(id); if (!r) return null; const next = { ...r, enabled: enabled ? 1 : 0 }; rows.set(id, next); return next; },
    unregisterTool: async (id) => rows.delete(id),
  };
  return { registry, runtime: new ToolRuntime({ registry }), rows };
}
const definition = (safetyLevel = "read_only"): ToolDefinition => ({ id: "test", name: "test", category: "system", description: "fixture", safetyLevel });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

describe("instance-owned tool contributions", () => {
  it("旧 disposer 不删除同 ID 新贡献；重复释放幂等且不删持久数据", async () => {
    const { runtime, rows } = fixture();
    const releaseA = await runtime.registerContribution(definition(), { call: async () => "A" });
    const releaseB = await runtime.registerContribution(definition(), { call: async () => "B" });
    releaseA(); releaseA();
    expect(await runtime.callTool(ctx, "test", {})).toBe("B");
    releaseB(); releaseB();
    expect(await runtime.exportRegistry()).toEqual([]);
    expect(rows.has("test")).toBe(true);
    await expect(runtime.callTool(ctx, "test", {})).rejects.toThrow("not registered");
  });

  it("A 的只读元数据查询未返回时换成写贡献 B，不执行 B 或复活 A", async () => {
    const { runtime, registry } = fixture();
    await runtime.registerContribution(definition(), { call: async () => "A" });
    const old = await registry.getTool("test");
    const delayed = deferred<ToolRegistrationModel | null>();
    const read = vi.spyOn(registry, "getTool").mockImplementationOnce(() => delayed.promise);
    const call = runtime.callTool(ctx, "test", {});
    const rejected = expect(call).rejects.toThrow("expired");
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    const write = vi.fn(async () => "B");
    await runtime.registerContribution(definition("write_with_approval"), { call: write });
    delayed.resolve(old);
    await rejected;
    await expect(runtime.callTool(ctx, "test", {})).rejects.toThrow("approval");
    expect(write).not.toHaveBeenCalled();
  });

  it("注册未完成不发布快照；失败后无可调用 handler", async () => {
    const { runtime, registry } = fixture();
    vi.spyOn(registry, "registerTool").mockRejectedValueOnce(new Error("persist failed"));
    await expect(runtime.registerContribution(definition(), { call: async () => 1 })).rejects.toThrow("persist failed");
    expect(await runtime.exportRegistry()).toEqual([]);
  });

  it("释放会取消在途调用，忽略迟到结果；关闭后不能再注册", async () => {
    const { runtime } = fixture();
    const started = deferred<AbortSignal>(); const result = deferred<string>();
    const release = await runtime.registerContribution(definition(), { call: async (_ctx, _args, control) => { started.resolve(control.signal); return result.promise; } });
    const call = runtime.callTool(ctx, "test", {});
    const rejected = expect(call).rejects.toThrow("expired");
    const signal = await started.promise;
    release(); expect(signal.aborted).toBe(true); await rejected;
    result.resolve("late");
    runtime.dispose(); runtime.dispose();
    await expect(runtime.registerContribution(definition(), { call: async () => 1 })).rejects.toThrow("disposed");
  });

  it("元数据被外部更改时旧 handler 不获得更宽权限", async () => {
    const { runtime } = fixture();
    const write = vi.fn(async () => "write");
    await runtime.registerContribution(definition("write_with_approval"), { call: write });
    await runtime.registerTool(definition("read_only"));
    await expect(runtime.callTool(ctx, "test", {})).rejects.toThrow("definition changed");
    expect(write).not.toHaveBeenCalled();
  });

  it("Memory 贡献只需窄写 Port，移除后其它工具和数据持有者不受影响", async () => {
    const { runtime } = fixture();
    const data: string[] = [];
    const memory = { store: vi.fn(async (_ctx, input) => { data.push(input.content); return { memoryId: "m1", isCandidate: false, embeddingStatus: "skipped" as const }; }) };
    await runtime.registerContribution(definition(), { call: async () => "other" });
    const release = await contributeMemoryTool(runtime, memory);
    await runtime.callTool(ctx, "aervox_memory_store", { content: "keep" }, { approval: true });
    release();
    expect(await runtime.callTool(ctx, "test", {})).toBe("other");
    expect(data).toEqual(["keep"]);
    expect((await runtime.exportRegistry()).map((r) => r.id)).toEqual(["test"]);
    const restored = await contributeMemoryTool(runtime, memory);
    expect(data).toEqual(["keep"]); restored(); runtime.dispose();
  });
});

it("开关轮换取消在途调用，原贡献句柄仍释放最新代际且不删除替换贡献", async () => {
  const { runtime } = fixture();
  const started = deferred<AbortSignal>();
  const pending = deferred<string>();
  const release = await runtime.registerContribution(definition(), { call: async (_ctx, _args, control) => { started.resolve(control.signal); return pending.promise; } });
  const call = runtime.callTool(ctx, "test", {});
  const rejected = expect(call).rejects.toThrow("expired");
  const signal = await started.promise;
  await runtime.setEnabled("test", false);
  expect(signal.aborted).toBe(true);
  await rejected;
  await runtime.setEnabled("test", true);
  release(); release();
  expect(await runtime.exportRegistry()).toEqual([]);
  await expect(runtime.callTool(ctx, "test", {})).rejects.toThrow("not registered");
  await runtime.registerContribution(definition(), { call: async () => "replacement" });
  release();
  expect(await runtime.callTool(ctx, "test", {})).toBe("replacement");
  pending.resolve("stale");
  runtime.dispose();
});
