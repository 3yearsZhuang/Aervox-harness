import { describe, it, expect, vi } from "vitest";
import { ToolRuntime, type ToolRegistryPort } from "../src/modules/ecosystem/tools/runtime.js";
import { contributeMemoryTool, type MemoryWritePort } from "../src/modules/companion/memory/tool-contribution.js";
import type { ToolRegistrationModel } from "@aervox/repositories";
import type { LocalContext } from "@aervox/repositories";

describe("MemoryStore 工具贡献与可移除性演练 (BTD-03 / BTD-07)", () => {
  const ctx: LocalContext = { workspaceId: "ws_test", subjectUserId: "user_test" };

  function createFakeRegistry(): ToolRegistryPort {
    const store = new Map<string, ToolRegistrationModel>();
    return {
      getTool: async (id) => store.get(id) ?? null,
      listTools: async () => Array.from(store.values()),
      registerTool: async (tool) => {
        const existing = store.get(tool.id);
        const record: ToolRegistrationModel = {
          id: tool.id,
          name: tool.name,
          description: tool.description,
          category: tool.category,
          safetyLevel: tool.safetyLevel ?? "write_with_approval",
          requiredPermissionsJson: JSON.stringify(tool.requiredPermissions ?? []),
          inputSchemaJson: JSON.stringify(tool.inputSchema),
          pluginId: tool.pluginId ?? null,
          builtin: tool.builtin ? 1 : 0,
          gatingConditionsJson: JSON.stringify(tool.gatingConditions ?? []),
          enabled: existing ? existing.enabled : 1,
          priority: tool.priority ?? 0,
          replay: tool.replay ?? "allowed",
          createdAt: existing?.createdAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        store.set(tool.id, record);
        return record;
      },
      setEnabled: async (id, enabled) => {
        const item = store.get(id);
        if (item) item.enabled = enabled ? 1 : 0;
      },
      unregisterTool: async (id) => {
        store.delete(id);
      },
      exportRegistry: async (options) => {
        return Array.from(store.values()).filter((t) => {
          if (options?.category && t.category !== options.category) return false;
          if (options?.disabledToolIds?.includes(t.id)) return false;
          return t.enabled === 1;
        });
      },
    };
  }

  it("Fake ToolRegistry 即可独立构造通用 ToolRuntime，不依赖任何数据库或 Memory 表", async () => {
    const fakeRegistry = createFakeRegistry();
    const runtime = new ToolRuntime({ registry: fakeRegistry });

    // 注册非 Memory 的通用工具
    await runtime.registerContribution({
      id: "echo_tool",
      name: "echo_tool",
      description: "Echo test tool",
      category: "utility",
      safetyLevel: "read_only",
      requiredPermissions: [],
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
      builtin: false,
      gatingConditions: [],
      priority: 1,
    }, {
      call: async (_c, args) => ({ echoed: (args as { text?: string }).text }),
    });

    const tools = await runtime.exportRegistry();
    expect(tools.map((t) => t.id)).toEqual(["echo_tool"]);

    const result = await runtime.callTool(ctx, "echo_tool", { text: "hello" }, { approval: true });
    expect(result).toEqual({ echoed: "hello" });
  });

  it("挂载 MemoryStore 工具贡献并验证写入闭环", async () => {
    const fakeRegistry = createFakeRegistry();
    const runtime = new ToolRuntime({ registry: fakeRegistry });

    const storedMemories: Array<{ content: string; source: string }> = [];
    const fakeMemoryPort: MemoryWritePort = {
      store: async (_c, input) => {
        storedMemories.push({ content: input.content, source: input.source ?? "user_said" });
        return {
          id: `mem_${storedMemories.length}`,
          status: "confirmed",
          content: input.content,
          action: "created",
        };
      },
    };

    const dispose = await contributeMemoryTool(runtime, fakeMemoryPort);

    // 验证工具已被注册并在快照中可见
    const tools = await runtime.exportRegistry();
    const memTool = tools.find((t) => t.id === "aervox_memory_store");
    expect(memTool).toBeDefined();
    expect(memTool?.category).toBe("memory");

    // 调用工具执行记忆存储
    const out = await runtime.callTool(
      ctx,
      "aervox_memory_store",
      { content: "User likes green tea", source: "user_said" },
      { approval: true },
    );
    expect(out).toMatchObject({ status: "confirmed", content: "User likes green tea" });
    expect(storedMemories).toHaveLength(1);

    dispose();
  });

  it("移除 MemoryStore 工具贡献后：其他工具保持可用，Memory 工具被卸载且不残留活跃引用", async () => {
    const fakeRegistry = createFakeRegistry();
    const runtime = new ToolRuntime({ registry: fakeRegistry });

    // 1. 注册另一个独立工具（如天气或插件工具）
    await runtime.registerContribution({
      id: "weather_tool",
      name: "weather_tool",
      description: "Weather tool",
      category: "utility",
      safetyLevel: "read_only",
      requiredPermissions: [],
      inputSchema: { type: "object" },
      builtin: false,
      gatingConditions: [],
      priority: 1,
    }, {
      call: async () => ({ temp: 22 }),
    });

    // 2. 挂载 MemoryStore 工具
    const storedMemories: string[] = [];
    const fakeMemoryPort: MemoryWritePort = {
      store: async (_c, input) => {
        storedMemories.push(input.content);
        return { id: "m1", status: "confirmed", content: input.content, action: "created" };
      },
    };
    const disposeMemory = await contributeMemoryTool(runtime, fakeMemoryPort);

    // 两个工具均可用
    let tools = await runtime.exportRegistry();
    expect(tools.map((t) => t.id).sort()).toEqual(["aervox_memory_store", "weather_tool"].sort());

    // 3. 物理退出/卸载 Memory 工具贡献（模拟 Build to Delete）
    disposeMemory();

    // 4. 验证 Memory 工具不再出现在可调用快照中
    tools = await runtime.exportRegistry();
    expect(tools.map((t) => t.id)).toEqual(["weather_tool"]);

    // 5. 再次调用 Memory 工具必须被阻断
    await expect(
      runtime.callTool(ctx, "aervox_memory_store", { content: "test" }, { approval: true }),
    ).rejects.toThrow();

    // 6. 其它独立工具不受任何影响，继续正常调用
    const weatherResult = await runtime.callTool(ctx, "weather_tool", {}, { approval: true });
    expect(weatherResult).toEqual({ temp: 22 });

    // 7. 记忆数据源不受工具卸载影响，已存数据保持完整
    expect(storedMemories).toEqual([]);
  });
});
