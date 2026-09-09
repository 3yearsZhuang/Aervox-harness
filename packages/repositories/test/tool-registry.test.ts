import { describe, it, expect, beforeEach } from "vitest";
import type { Client } from "@libsql/client";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteToolRegistryRepository,
  type AervoxDatabase,
} from "../src/index.js";

describe("T-04 工具注册表 + AST-04 门控 + PET-05 安全级别", () => {
  let db: AervoxDatabase;
  let client: Client;
  let repo: SqliteToolRegistryRepository;

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    await initDatabaseSchema(client);
    repo = new SqliteToolRegistryRepository(db);
  });

  it("注册工具并读取", async () => {
    const tool = await repo.registerTool({
      id: "aervox_memory_store",
      name: "aervox_memory_store",
      description: "主动存储长期记忆",
      category: "memory",
      safetyLevel: "write_with_approval",
      requiredPermissions: ["memory:write"],
      inputSchema: { type: "object", properties: { content: { type: "string" } } },
      builtin: true,
      priority: 10,
    });

    expect(tool.id).toBe("aervox_memory_store");
    expect(tool.safetyLevel).toBe("write_with_approval");
    expect(tool.builtin).toBe(1);
    expect(tool.enabled).toBe(1);
    expect(tool.priority).toBe(10);

    const found = await repo.getTool("aervox_memory_store");
    expect(found).not.toBeNull();
    expect(found!.name).toBe("aervox_memory_store");
  });

  it("PET-05 read_only 安全级别标记", async () => {
    await repo.registerTool({
      id: "aervox_memory_search",
      name: "aervox_memory_search",
      description: "检索记忆（只读）",
      category: "search",
      safetyLevel: "read_only",
      builtin: true,
    });

    const found = await repo.getTool("aervox_memory_search");
    expect(found!.safetyLevel).toBe("read_only");
  });

  it("幂等注册：同 id 覆盖元数据但 enabled 保持不变", async () => {
    await repo.registerTool({
      id: "tool_a",
      name: "Tool A",
      description: "初始描述",
      category: "system",
    });

    // 禁用工具
    await repo.setEnabled("tool_a", false);

    // 重新注册（更新元数据）
    const updated = await repo.registerTool({
      id: "tool_a",
      name: "Tool A v2",
      description: "更新描述",
      category: "system",
    });

    expect(updated.name).toBe("Tool A v2");
    expect(updated.description).toBe("更新描述");
    // enabled 保持为 0（未被重置）
    expect(updated.enabled).toBe(0);
  });

  it("B3 replay 声明：safe/never 存取、省略为 null、幂等覆盖", async () => {
    const safe = await repo.registerTool({
      id: "tool_safe",
      name: "tool_safe",
      description: "可合成",
      category: "system",
      replay: "safe",
    });
    expect(safe.replay).toBe("safe");
    expect((await repo.getTool("tool_safe"))!.replay).toBe("safe");

    const never = await repo.registerTool({
      id: "tool_never",
      name: "tool_never",
      description: "不可重放",
      category: "system",
      replay: "never",
    });
    expect(never.replay).toBe("never");

    // 省略 → 未声明（fail-closed）
    const unset = await repo.registerTool({
      id: "tool_unset",
      name: "tool_unset",
      description: "未声明",
      category: "system",
    });
    expect(unset.replay ?? null).toBeNull();

    // 幂等注册覆盖 replay
    const overridden = await repo.registerTool({
      id: "tool_safe",
      name: "tool_safe",
      description: "改主意",
      category: "system",
      replay: "never",
    });
    expect(overridden.replay).toBe("never");
  });

  it("setEnabled 禁用/启用", async () => {
    await repo.registerTool({
      id: "tool_b",
      name: "Tool B",
      description: "测试禁用",
      category: "learning",
    });

    const disabled = await repo.setEnabled("tool_b", false);
    expect(disabled!.enabled).toBe(0);

    const enabled = await repo.setEnabled("tool_b", true);
    expect(enabled!.enabled).toBe(1);
  });

  it("unregisterTool：内置工具不可注销", async () => {
    await repo.registerTool({
      id: "builtin_tool",
      name: "Builtin",
      description: "内置工具",
      category: "system",
      builtin: true,
    });

    const result = await repo.unregisterTool("builtin_tool");
    expect(result).toBe(false);

    const stillExists = await repo.getTool("builtin_tool");
    expect(stillExists).not.toBeNull();
  });

  it("unregisterTool：非内置工具可注销", async () => {
    await repo.registerTool({
      id: "plugin_tool",
      name: "Plugin Tool",
      description: "插件工具",
      category: "external",
      builtin: false,
      pluginId: "plugin_1",
    });

    const result = await repo.unregisterTool("plugin_tool");
    expect(result).toBe(true);

    const gone = await repo.getTool("plugin_tool");
    expect(gone).toBeNull();
  });

  it("exportRegistry：过滤禁用工具 + 全局禁用列表", async () => {
    await repo.registerTool({
      id: "tool_enabled",
      name: "Enabled Tool",
      description: "启用的工具",
      category: "memory",
      priority: 5,
    });
    await repo.registerTool({
      id: "tool_disabled",
      name: "Disabled Tool",
      description: "禁用的工具",
      category: "memory",
      priority: 10,
    });
    await repo.setEnabled("tool_disabled", false);
    await repo.registerTool({
      id: "tool_global_disabled",
      name: "Global Disabled",
      description: "全局禁用",
      category: "memory",
      priority: 15,
    });

    const exported = await repo.exportRegistry({
      disabledToolIds: ["tool_global_disabled"],
    });

    expect(exported).toHaveLength(1);
    expect(exported[0].id).toBe("tool_enabled");
  });

  it("exportRegistry：按分类过滤", async () => {
    await repo.registerTool({
      id: "tool_mem",
      name: "Memory Tool",
      description: "记忆工具",
      category: "memory",
    });
    await repo.registerTool({
      id: "tool_search",
      name: "Search Tool",
      description: "搜索工具",
      category: "search",
    });

    const memoryTools = await repo.exportRegistry({ category: "memory" });
    expect(memoryTools).toHaveLength(1);
    expect(memoryTools[0].id).toBe("tool_mem");
  });

  it("AST-04 门控条件过滤", async () => {
    await repo.registerTool({
      id: "tool_gated",
      name: "Gated Tool",
      description: "有门控条件的工具",
      category: "memory",
      gatingConditions: [
        { field: "purpose", operator: "equals", value: "teaching" },
      ],
    });
    await repo.registerTool({
      id: "tool_ungated",
      name: "Ungated Tool",
      description: "无门控条件的工具",
      category: "memory",
    });

    // 门控求值：purpose === "teaching" 时通过
    const exportedPass = await repo.exportRegistry({
      gatingEvaluator: (cond) => {
        if (cond.operator === "equals" && cond.field === "purpose") {
          return cond.value === "teaching";
        }
        return true;
      },
    });

    // 门控通过时两个工具都应出现
    expect(exportedPass).toHaveLength(2);

    // 门控求值：purpose === "diary" 时不通过
    const exportedFail = await repo.exportRegistry({
      gatingEvaluator: (cond) => {
        if (cond.operator === "equals" && cond.field === "purpose") {
          return cond.value === "diary";
        }
        return true;
      },
    });

    // 门控不通过时只有 ungated 工具
    expect(exportedFail).toHaveLength(1);
    expect(exportedFail[0].id).toBe("tool_ungated");
  });

  it("exportRegistry：按 priority 降序排列", async () => {
    await repo.registerTool({
      id: "tool_low",
      name: "Low Priority",
      description: "低优先级",
      category: "system",
      priority: 1,
    });
    await repo.registerTool({
      id: "tool_high",
      name: "High Priority",
      description: "高优先级",
      category: "system",
      priority: 100,
    });
    await repo.registerTool({
      id: "tool_mid",
      name: "Mid Priority",
      description: "中优先级",
      category: "system",
      priority: 50,
    });

    const exported = await repo.exportRegistry();
    expect(exported[0].id).toBe("tool_high");
    expect(exported[1].id).toBe("tool_mid");
    expect(exported[2].id).toBe("tool_low");
  });
});
