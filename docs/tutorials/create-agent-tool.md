---
id: AVX-TUT-003
type: tutorial
scope: guide
owner: maintainers
doc_status: review-candidate
decision_status: not-applicable
delivery_status: not-applicable
version: 1.0.1
updated_at: 2026-09-13
reviewed_at: 2026-09-13
review_interval_days: 90
sources:
  - apps/api/src/modules/tools/runtime.ts
  - packages/agent-loop/src/types.ts
  - docs/reference/agent-harness-loop.md
  - docs/how-to/engineering-process.md
---

# 教程：编写并注册一个自定义 Agent 工具

- 提出人：3yearszhuang · 2026-09-10
- 修改人：3yearszhuang · 2026-09-13

关联：[Agent Harness Loop 规范](../reference/agent-harness-loop.md) · [工程与发布流程](../how-to/engineering-process.md) · [能力组合规范](../reference/capability-composition.md)

本教程带领开发者一步步为 Aervox Agent 编写一个自定义工具（Tool），完成参数 Schema 定义、安全级别配置、运行时 Handler 编写、数据库注册表持久化及集成测试验证。

---

## 1. 核心概念与安全级别

在 Aervox 中，每个工具向大语言模型声明为 OpenAI 兼容的 Function Calling Schema。系统在调用侧强制执行安全级别（依据 [PET-05 安全级别与工具注册表](../explanation/reference-design-transfer.md)）：

| 安全级别 | 行为表现 | 典型场景 |
|---|---|---|
| `read_only` | 模型可自主调用，无需用户审批确认 | 搜索、信息查询、历史记录检索、只读统计 |
| `write_with_approval` | 模型发起调用后挂起并生成审批请求，用户批准后方可执行 | 记录保存、修改配置、外发生效、删除数据 |
| `privileged` | 仅系统管理员通道透传，AI Agent 运行时一律拒绝 | 租户重置、底层凭据导出、系统级网络操作 |

---

## 2. 步骤 1 · 定义工具契约与 Zod Schema

在定义工具时，必须指定唯一的 `id`、功能描述及 JSON Schema 格式的参数规格。我们以编写一个查询当地天气或学习环境亮度的工具 `env_sensor_query` 为例：

```typescript
import { z } from "zod";

export const EnvSensorQueryArgsSchema = z.object({
  metric: z.enum(["temperature", "humidity", "ambient_light"]).describe("需要查询的环境指标"),
  location: z.string().default("desk").describe("测量点位置，默认桌前"),
});

export type EnvSensorQueryArgs = z.infer<typeof EnvSensorQueryArgsSchema>;
```

---

## 3. 步骤 2 · 实现 ToolHandler 处理器

工具处理器必须实现 `ToolHandler` 接口，接收本地上下文（`LocalContext`）、已校验参数及调用上下文（包含 `approval` 与 `proactiveAuthorization` 标记）：

```typescript
import type { LocalContext } from "@aervox/repositories";
import type { ToolHandler } from "apps/api/src/modules/tools/runtime.js";
import { type EnvSensorQueryArgs } from "./env-sensor-schemas.js";

export class EnvSensorQueryHandler implements ToolHandler {
  async call(
    localCtx: LocalContext,
    args: unknown,
    context: { approval: boolean; proactiveAuthorization: boolean }
  ): Promise<{ status: string; metric: string; value: number; unit: string }> {
    const validArgs = args as EnvSensorQueryArgs;

    // 根据参数执行具体逻辑（此处为示例数据）
    const sampleValues: Record<string, { value: number; unit: string }> = {
      temperature: { value: 24.5, unit: "°C" },
      humidity: { value: 55, unit: "%" },
      ambient_light: { value: 320, unit: "lux" },
    };

    const reading = sampleValues[validArgs.metric] ?? { value: 0, unit: "unknown" };

    return {
      status: "ok",
      metric: validArgs.metric,
      value: reading.value,
      unit: reading.unit,
    };
  }
}
```

---

## 4. 步骤 3 · 注册到 ToolRuntime 与数据库

在应用启动时（`apps/api/src/modules/tools/`），将工具元数据写入持久化注册表，并把 Handler 注入 `ToolRuntime`：

```typescript
import type { ToolRuntime } from "./runtime.js";
import { EnvSensorQueryHandler } from "./env-sensor-handler.js";

export async function registerCustomTools(runtime: ToolRuntime, registryRepo: any) {
  const toolId = "aervox_env_sensor_query";

  // 1. 持久化到工具注册表
  await registryRepo.registerTool({
    id: toolId,
    name: "环境传感器查询",
    description: "查询用户桌前环境的温度、湿度或环境光线指标",
    safetyLevel: "read_only", // 只读安全级别
    parametersSchema: JSON.stringify({
      type: "object",
      properties: {
        metric: {
          type: "string",
          enum: ["temperature", "humidity", "ambient_light"],
          description: "需要查询的环境指标",
        },
        location: { type: "string", default: "desk", description: "测量点位置" },
      },
      required: ["metric"],
    }),
    isEnabled: true,
  });

  // 2. 注入内存运行时派发器
  runtime.registerHandler(toolId, new EnvSensorQueryHandler());
}
```

---

## 5. 步骤 4 · 编写集成测试验证

在 `apps/api/test/` 下添加针对新工具的单元/集成测试，验证白名单拦截与正常执行：

```typescript
import { describe, it, expect } from "vitest";

describe("Custom Tool: aervox_env_sensor_query", () => {
  it("should successfully execute read_only sensor tool", async () => {
    const handler = new EnvSensorQueryHandler();
    const result = await handler.call(
      { actorId: "actor_test" },
      { metric: "temperature" },
      { approval: false, proactiveAuthorization: false }
    );

    expect(result).toEqual({
      status: "ok",
      metric: "temperature",
      value: 24.5,
      unit: "°C",
    });
  });
});
```

---

## 6. 自检清单

完成工具开发后，运行以下命令验证代码与文档质量：

```bash
mise x -- pnpm check:boundary    # 确保没有突破 packages 架构分层
mise tasks run ci-code           # 运行 Lint 与集成测试
mise tasks run ci-docs           # 验证文档引用与语法规范
```
