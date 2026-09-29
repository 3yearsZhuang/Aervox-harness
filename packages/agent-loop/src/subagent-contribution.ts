/**
 * Aervox｜思隅 @aervox/agent-loop — Subagent/Workflow Contribution（阶段 5c）
 *
 * 规则依据：AVX-HAR-001 §13 阶段 5「Subagent/Workflow 通过独立 Tool/Provider Contribution
 * 接入」+ ADR-017「高级能力经扩展点接入，不改 Loop 核心控制流与事件契约」。
 *
 * 实现形态（全部是 ToolProviderPort 层面的组装，executor 无感知）：
 * - `composeToolProviders`：把宿主贡献的多个 ToolProviderPort 合并为单一清单交付 executor，
 *   重名工具在组装期报错；execute 按名路由，未命中 fail-closed（与既有语义一致）；
 * - `createSubagentToolProvider`：贡献 `subagent_delegate` 工具（写类，走既有审批通道），
 *   执行时委托宿主持有的 SubagentPort 创建独立子任务（落库审计/恢复）；未注入时不为模型
 *   提供该工具（退化安全）；
 * - `createWorkflowToolProvider`：把宿主声明的 TypeScript 步骤定义暴露为 `workflow_run` 工具
 *   （写类走审批），步骤顺序执行、上一步输出作为下一步输入；未注册流程 fail-closed。
 */
import type { SubagentPort, ToolExecutionInput, ToolExecutionResult, ToolProviderPort } from "./ports.js";
import type { ToolSpec, WorkflowContext, WorkflowDefinition } from "./types.js";

/** Subagent 委托工具名（模型可见；Leader 标识由 Host 幂等键承载） */
export const SUBAGENT_DELEGATE_TOOL = "subagent_delegate";
/** Workflow 编排工具名（参数携带 workflow 选择） */
export const WORKFLOW_RUN_TOOL = "workflow_run";

/**
 * 合并多个 ToolProviderPort 为单一清单（5c Provider Contribution）：
 * - 工具清单取 providers 并集；重名（name 冲突）在组装期抛错，杜绝执行期歧义路由；
 * - execute 按 name 路由到声明它的 provider；
 * - 未命中时：存在 `fallback` 则委托其执行（支持「动态注册表」provider——execute 时实时校验
 *   注册表并自判 unregistered/审批，如 apps/api 的 createRuntimeToolProvider）；
 *   fallback 的 tools 非空时一并并入模型清单（重名以 providers 优先），保证真实 LLM 模式下
 *   注册表工具对模型可见；无 fallback 则 fail-closed（与既有未注册语义一致）。
 */
export function composeToolProviders(
  providers: ToolProviderPort[],
  opts: { fallback?: ToolProviderPort } = {},
): ToolProviderPort {
  const nameToProvider = new Map<string, ToolProviderPort>();
  const tools: ToolSpec[] = [];
  for (const provider of providers) {
    for (const tool of provider.tools) {
      const existing = nameToProvider.get(tool.name);
      if (existing && existing !== provider) {
        throw new Error(`composeToolProviders: duplicate tool name "${tool.name}" across providers`);
      }
      if (!existing) {
        nameToProvider.set(tool.name, provider);
        tools.push(tool);
      }
    }
  }
  const fallback = opts.fallback;
  // fallback 携带预载清单时并入（模型可见性）；执行仍按 name 未命中回落到 fallback
  for (const tool of opts.fallback?.tools ?? []) {
    if (!nameToProvider.has(tool.name) && opts.fallback) {
      nameToProvider.set(tool.name, opts.fallback);
      tools.push(tool);
    }
  }
  return {
    tools,
    async execute(input: ToolExecutionInput): Promise<ToolExecutionResult> {
      const provider = nameToProvider.get(input.name);
      if (provider) {
        return provider.execute(input);
      }
      // 未命中（含 fallback 清单之外的动态注册名）仍委托 fallback 自判：注册表 provider
      // 实时校验 enabled/授权，语义为 unregistered/disabled/approval 由其自行返回
      if (fallback) {
        return fallback.execute(input);
      }
      return { ok: false, error: `unregistered_tool: ${input.name}` };
    },
  };
}

/**
 * 阶段 5c：Subagent 委托工具 provider。
 * - 未注入 SubagentPort 时工具清单为空（模型不会看到委托工具，行为与既有完全一致）；
 * - 工具为写类（readOnly=false）：与 5a-2 受控入口对称，委托产生持久化子任务，须既有审批通道放行；
 * - 执行即调用 SubagentPort.delegate（Host 侧创建子 turn/attempt 落库）；子任务失败以
 *   tool_result(ok:false) 返回，Leader Loop 按既有工具失败语义继续/收敛。
 */
export function createSubagentToolProvider(deps: { subagent?: SubagentPort } = {}): ToolProviderPort {
  const tools: ToolSpec[] = deps.subagent
    ? [
        {
          name: SUBAGENT_DELEGATE_TOOL,
          description:
            "把一段子任务委托给独立 Subagent 执行（创建独立子 Turn 落库审计）：参数 { task: 子任务目标描述 }。结果含 subTurnId/subAttemptId/resultText。",
          readOnly: false,
        },
      ]
    : [];
  return {
    tools,
    async execute(input) {
      if (!deps.subagent) {
        return { ok: false, error: "subagent_disabled" };
      }
      if (input.name !== SUBAGENT_DELEGATE_TOOL) {
        return { ok: false, error: `unregistered_tool: ${input.name}` };
      }
      const args = (input.arguments ?? {}) as { task?: unknown };
      if (typeof args.task !== "string" || args.task.trim().length === 0) {
        return { ok: false, error: `${SUBAGENT_DELEGATE_TOOL} requires string field \`task\`` };
      }
      try {
        const run = await deps.subagent.delegate({
          parentTurnId: input.turnId,
          parentAttemptId: input.attemptId,
          parentExecutionId: input.invocationId,
          sessionId: input.sessionId ?? "",
          task: args.task,
        });
        return {
          ok: run.status === "Completed",
          output: run,
          error: run.error,
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "subagent_execution_error" };
      }
    },
  };
}

/**
 * 阶段 5c：Workflow 编排工具 provider（TypeScript 步骤定义形态）。
 * - 无定义时不贡献工具（退化安全）；有一个及以上定义时暴露 `workflow_run`（写类，走既有审批）；
 * - 执行：按 `{ name, input }` 选择定义，步骤顺序执行，上一步输出作为下一步输入；
 *   任一步失败（返回 !ok 或抛错）即整体失败并携带步骤定位与部分产物，Leader 可据既有语义重试；
 * - 未注册流程名 fail-closed（unregistered_workflow）。
 */
export function createWorkflowToolProvider(defs: WorkflowDefinition[]): ToolProviderPort {
  const byName = new Map(defs.map((d) => [d.name, d]));
  const tools: ToolSpec[] =
    defs.length > 0
      ? [
          {
            name: WORKFLOW_RUN_TOOL,
            description:
              "运行一个预定义多步工作流：参数 { name: 工作流名, input: 首个步骤输入 }。输出含各步骤结果数组。可用流程见 GET /v1/workflows。",
            readOnly: false,
          },
        ]
      : [];
  return {
    tools,
    async execute(input) {
      if (input.name !== WORKFLOW_RUN_TOOL) {
        return { ok: false, error: `unregistered_tool: ${input.name}` };
      }
      const args = (input.arguments ?? {}) as { name?: unknown; input?: unknown };
      const def = typeof args.name === "string" ? byName.get(args.name) : undefined;
      if (!def) {
        return { ok: false, error: `unregistered_workflow: ${String(args.name)}` };
      }
      const ctx: WorkflowContext = {
        turnId: input.turnId,
        attemptId: input.attemptId,
        sessionId: input.sessionId ?? "",
      };
      const partial: unknown[] = [];
      let value = args.input;
      for (let i = 0; i < def.steps.length; i += 1) {
        const step = def.steps[i];
        if (!step) {
          return { ok: false, error: `workflow "${def.name}" step ${i + 1} missing definition` };
        }
        try {
          const res = await step.execute(ctx, value);
          if (!res.ok) {
            return {
              ok: false,
              error: `workflow "${def.name}" step ${i + 1} (${step.description}) failed: ${res.error ?? "step_error"}`,
              output: { failedStep: i + 1, partial },
            };
          }
          partial.push(res.output);
          value = res.output;
        } catch (err) {
          return {
            ok: false,
            error: `workflow "${def.name}" step ${i + 1} (${step.description}) threw: ${err instanceof Error ? err.message : String(err)}`,
            output: { failedStep: i + 1, partial },
          };
        }
      }
      return { ok: true, output: { steps: partial } };
    },
  };
}
