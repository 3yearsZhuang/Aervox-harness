/**
 * Aervox｜思隅 @aervox/core — 统一运行诊断清单与 Trace-to-Eval 导出（白盒运行观测）
 *
 * 将一次 Turn 执行中的上下文准备、模型 Step、工具派发与审批记录汇聚为统一的白盒运行视图，
 * 可导出模型调用拓扑夹具；默认移除正文与参数，回放需要隔离的桩工具。
 */
import type {
  ContextPruningReport,
  ModelStopReason,
  ModelUsage,
  ToolCallRequest,
  ToolExecutionStatus,
} from "./types.js";
import type { ReplayStep } from "./replay-provider.js";

export interface DiagnosticsTimelineItem {
  phase: "before_turn_hook" | "context_build" | "model_step" | "tool_execution" | "approval_wait" | "after_turn_hook";
  identifier?: string;
  startedAtMs: number;
  durationMs: number;
  status: "success" | "error" | "interrupted";
  details?: Record<string, unknown>;
}

export interface RunDiagnosticsManifest {
  runId: string;
  turnId: string;
  sessionId: string;
  attemptId: string;
  startedAt: string;
  finishedAt?: string;
  durationMs: number;
  status: "completed" | "interrupted" | "failed" | "cancelled" | "skipped";
  configuration: {
    persona?: { name?: string; source?: string };
    skills?: Array<{ name: string; loaded?: boolean }>;
    tools?: {
      declared: string[];
      gatedOut?: Array<{ name: string; reason: string }>;
      active: Array<{ name: string; safetyLevel?: string; readOnly: boolean }>;
    };
    modelRouting?: { provider?: string; modelId?: string; tier?: string; reason?: string };
  };
  timeBreakdown?: {
    modelLatencyMs: number;
    toolExecutionMs: number;
    pluginHookMs?: number;
    approvalWaitMs?: number;
  };
  contextPruning?: ContextPruningReport;
  timeline?: DiagnosticsTimelineItem[];
  modelSteps: Array<{
    step: number;
    modelRunId: string;
    contextManifestId?: string;
    status?: "completed" | "failed";
    /** False when the existing telemetry store rejected this write. */
    recorded?: boolean;
    toolCalls?: ToolCallRequest[];
    latencyMs?: number;
    usage?: ModelUsage;
    stopReason?: ModelStopReason;
    toolCallsRequested?: string[];
    responseText?: string;
  }>;
  toolExecutions: Array<{
    invocationId: string;
    toolName: string;
    status: ToolExecutionStatus;
    durationMs?: number;
    error?: string;
    approvalId?: string;
    output?: unknown;
  }>;
}

export interface SanitizedEvalFixture {
  name: string;
  description: string;
  exportedAt: string;
  script: ReplayStep[];
  expectedFinalStatus?: string;
  expectedToolsExecuted: string[];
  metadata: Record<string, unknown>;
}

/**
 * 默认仅导出脱敏调用拓扑，不承诺重现授权、工具副作用或失败语义。
 * scrubUserContent=false 是调用者显式选择保留原始正文和参数。
 */
export function exportSanitizedEvalFixture(
  manifest: RunDiagnosticsManifest,
  options: {
    name?: string;
    description?: string;
    scrubUserContent?: boolean;
    toolCallArgumentsMap?: Record<string, unknown>;
  } = {},
): SanitizedEvalFixture {
  const scrub = options.scrubUserContent ?? true;
  const replayLimitations: string[] = [];
  if (manifest.status !== "completed") replayLimitations.push("source_not_completed");
  if (manifest.modelSteps.some(step => step.status === "failed")) replayLimitations.push("failed_model_calls_require_custom_provider");
  if (new Set(manifest.modelSteps.map(step => step.step)).size !== manifest.modelSteps.length) replayLimitations.push("retries_require_custom_provider");

  const script: ReplayStep[] = manifest.modelSteps.map((step) => {
    const text = scrub ? "(sanitized model response)" : (step.responseText ?? "");
    const toolCalls: ToolCallRequest[] | undefined =
      step.toolCallsRequested && step.toolCallsRequested.length > 0
        ? step.toolCallsRequested.map((name, idx) => ({
            id: `call_${step.step}_${idx + 1}`,
            name,
            arguments: scrub ? { scrubbed: true } : options.toolCallArgumentsMap?.[name] ?? step.toolCalls?.[idx]?.arguments ?? {},
          }))
        : undefined;

    return {
      text,
      toolCalls,
    };
  });

  const expectedToolsExecuted = manifest.toolExecutions
    .filter((te) => te.status === "executed")
    .map((te) => te.toolName);

  return {
    name: options.name ?? (scrub ? "sanitized_eval" : `eval_${manifest.turnId}_${manifest.attemptId}`),
    description: options.description ?? `Exported eval fixture (status: ${manifest.status})`,
    exportedAt: new Date().toISOString(),
    script,
    expectedFinalStatus: replayLimitations.length === 0 ? manifest.status : undefined,
    expectedToolsExecuted,
    metadata: {
      sourceStatus: manifest.status,
      replayLimitations,
      ...(scrub ? { replayRequiresStubTools: true } : { turnId: manifest.turnId, attemptId: manifest.attemptId, configuration: manifest.configuration }),
      modelStepsCount: manifest.modelSteps.length,
      toolExecutionsCount: manifest.toolExecutions.length,
    },
  };
}
