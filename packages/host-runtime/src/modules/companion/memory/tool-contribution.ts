import type { LocalContext } from "@aervox/repositories";
import type { MemoryStoreToolInput, MemoryStoreToolOutput } from "@aervox/contracts";
import type { ToolContributionPort, ToolDisposer } from "../../ecosystem/tools/index.js";

export interface MemoryWritePort {
  store(ctx: LocalContext, input: MemoryStoreToolInput): Promise<MemoryStoreToolOutput>;
}
export function contributeMemoryTool(runtime: ToolContributionPort, memory: MemoryWritePort): Promise<ToolDisposer> {
  return runtime.registerContribution({
    id: "aervox_memory_store",
    name: "aervox_memory_store",
    description:
      "主动存储长期记忆：AI 在对话中把值得长期记住的内容（身份/偏好/习惯/日程/事件）显式写入记忆库；user_said 直接置信，ai_inferred 默认进入候选待用户确认。",
    category: "memory",
    safetyLevel: "write_with_approval",
    requiredPermissions: [],
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "记忆内容（自然语言）" },
        source: { type: "string", enum: ["user_said", "ai_inferred"] },
        category: {
          type: "string",
          enum: ["identity", "preference", "habit", "schedule", "relationship", "event", "other"],
        },
        keywords: { type: "array", items: { type: "string" } },
        sourceTurnId: { type: "string" },
        asCandidate: { type: "boolean" },
      },
      required: ["content"],
    },
    builtin: true,
    gatingConditions: [],
    priority: 100,
  }, { call: (ctx, args, control) => {
    control.signal.throwIfAborted();
    return memory.store(ctx, args as MemoryStoreToolInput);
  } });
}
