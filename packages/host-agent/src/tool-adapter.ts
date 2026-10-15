/**
 * Aervox｜思隅 @aervox/host-agent — 工具运行时适配器
 *
 * 将 HostToolRuntime 封装为 Agent Loop 所需的 ToolProviderPort，供 Worker / 独立 AgentHost 调度使用。
 */
import type { ToolProviderPort, ToolExecutionInput, ToolExecutionResult } from "@aervox/core";
import { inspectToolInput, HostToolRuntime } from "@aervox/core";
import type { SqliteConversationRepository, LocalContext } from "@aervox/repositories";

export interface CreateHostToolProviderOptions {
  ctx?: LocalContext;
  autoApprove?: boolean;
}

export function createHostToolProvider(
  runtime: HostToolRuntime,
  _repo?: SqliteConversationRepository,
  options: CreateHostToolProviderOptions = {},
): ToolProviderPort {
  const localCtx = options.ctx ?? { workspaceId: "local", subjectUserId: "local" };
  const autoApprove = options.autoApprove ?? false;

  return {
    tools: [],
    async listTools(options) {
      options?.signal?.throwIfAborted();
      const tools = await runtime.exportRegistry();
      options?.signal?.throwIfAborted();
      return tools.map((t) => ({
        name: t.name,
        description: t.description,
        readOnly: t.safetyLevel === "read_only",
        parameters:
          t.inputSchemaJson && typeof t.inputSchemaJson === "object"
            ? (t.inputSchemaJson as Record<string, unknown>)
            : undefined,
      }));
    },
    async execute(input: ToolExecutionInput): Promise<ToolExecutionResult> {
      const inspection = inspectToolInput({ name: input.name, arguments: input.arguments });
      if (!inspection.safe) {
        return { ok: false, error: `unsafe_tool_arguments: ${inspection.reason ?? "validation_failed"}` };
      }

      const tools = await runtime.listTools();
      const tool = tools.find((t) => t.name === input.name && t.enabled === 1);
      if (!tool) {
        return { ok: false, error: `unregistered_tool: ${input.name}` };
      }

      try {
        const output = await runtime.callTool(localCtx, tool.id, input.arguments, {
          approval: autoApprove,
          signal: input.signal,
          controlContext: input.controlContext,
        });
        return { ok: true, output };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
