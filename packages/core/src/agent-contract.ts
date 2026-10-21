import { createComposedContextBuilder } from "./context-builder.js";
import { executeTurn } from "./executor.js";
import type { ExecuteTurnDeps, ExecuteTurnOptions } from "./executor.js";
import type { ControlContext } from "./control-context.js";
import type { ExecutionStorePort, ModelProviderPort, ToolProviderPort, AgentStreamEvent } from "./ports.js";
import type { ModelStopReason, SkillDescriptor, ToolCallRequest, ToolSpec } from "./types.js";
import type { RunDiagnosticsManifest } from "./diagnostics-manifest.js";

/** An additive facade over executeTurn; the execution ledger retains all authority. */
export interface AgentDefinition {
  id: string;
  name: string;
  persona: { name: string; systemPrompt: string };
  skills?: SkillDescriptor[];
  /** Omitted inherits the host's tools; [] exposes no tools. Host constraints remain authoritative. */
  tools?: ToolSpec[];
  options?: Pick<ExecuteTurnOptions, "maxSteps" | "toolTimeoutMs" | "maxModelRetries" | "maxConsecutiveSameTool">;
}
export interface AgentRunResult {
  turnId: string;
  attemptId: string;
  status: "completed" | "interrupted" | "failed" | "cancelled" | "skipped";
  reason?: string;
  output: { text: string; reasoning?: string };
  toolsExecuted: Array<{ name: string; ok: boolean; output?: unknown; error?: string }>;
  interruption?: { type: string; approvalId?: string; toolName?: string; argumentsHash?: string; reason?: string };
  diagnostics: { stepsTaken: number; lastSequence: number; manifest: RunDiagnosticsManifest; warnings: string[] };
}
export interface RunAgentTurnInput {
  turnId: string;
  sessionId: string;
  attemptId: string;
  userMessage: string;
  controlContext?: ControlContext;
  resume?: ExecuteTurnOptions["resume"];
}
export type RunAgentTurnDeps = Pick<ExecuteTurnDeps,
  "execution" | "provider" | "tools" | "approvalPolicy" | "deletionGate" | "toolValidator" | "modelRunMeta"> &
  Partial<Pick<ExecuteTurnDeps, "contextBuilder" | "inbox">>;

function copyOutput(value: unknown): unknown {
  try { return structuredClone(value); } catch { return undefined; }
}

export async function runAgentTurn(agent: AgentDefinition, deps: RunAgentTurnDeps, input: RunAgentTurnInput): Promise<AgentRunResult> {
  const startedAt = Date.now();
  const warnings = new Set<string>();
  let eventStart = 0;
  try { eventStart = (await deps.execution.listEvents(input.turnId)).at(-1)?.sequence ?? 0; }
  catch { warnings.add("initial_events_unavailable"); }
  const modelSteps: RunDiagnosticsManifest["modelSteps"] = [];
  const outcomes = new Map<string, RunDiagnosticsManifest["toolExecutions"][number]>();
  const calls: Array<{ step: number; text: string; toolCalls: ToolCallRequest[]; stopReason?: ModelStopReason; linked: boolean }> = [];
  const activeTools = new Map<string, ToolSpec>();
  let contextPruning: RunDiagnosticsManifest["contextPruning"];
  const overrides: Partial<ExecutionStorePort> = {
    async recordModelRun(record) {
      const call = calls.findLast(item => !item.linked && item.step === record.stepId);
      if (call) call.linked = true;
      const step: RunDiagnosticsManifest["modelSteps"][number] = {
        step: record.stepId, modelRunId: record.runId, latencyMs: record.latencyMs,
        usage: record.usage, status: record.status, recorded: false,
        responseText: call?.text, stopReason: call?.stopReason,
        toolCalls: call?.toolCalls, toolCallsRequested: call?.toolCalls.map(tool => tool.name),
      };
      modelSteps.push(step);
      try { await deps.execution.recordModelRun(record); step.recorded = true; }
      catch (error) { warnings.add("model_run_write_failed"); throw error; }
    },
    async recordContextManifest(record) {
      for (const tool of record.requestSnapshot?.tools ?? []) activeTools.set(tool.name, structuredClone(tool));
      const step = modelSteps.find(item => item.modelRunId === record.modelRunId);
      try {
        await deps.execution.recordContextManifest(record);
        if (step) step.contextManifestId = record.manifestId;
      } catch (error) { warnings.add("context_manifest_write_failed"); throw error; }
    },
    async recordToolOutcome(record) {
      const result = await deps.execution.recordToolOutcome(record);
      if (result.ok) outcomes.set(record.invocationId, {
        invocationId: record.invocationId, toolName: record.name, status: record.status,
        durationMs: record.finishedAt ? Math.max(0, Date.parse(record.finishedAt) - Date.parse(record.startedAt)) : undefined,
        error: record.error, output: copyOutput(record.output),
      });
      return result;
    },
    async recordToolExecution(record) {
      await deps.execution.recordToolExecution(record);
      outcomes.set(record.invocationId, {
        invocationId: record.invocationId, toolName: record.name, status: record.status,
        error: record.error, output: copyOutput(record.output),
      });
    },
  };
  // Bind every unmodified method to the original store, preserving private fields,
  // transaction ownership, fencing and optional host capabilities.
  const execution = new Proxy(deps.execution, {
    get(target, key) {
      const override = overrides[key as keyof ExecutionStorePort];
      if (override) return override;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const baseBuilder = deps.contextBuilder ?? createComposedContextBuilder({
    baseSystemPrompt: { assistantName: agent.persona.name, personaPrompt: agent.persona.systemPrompt },
    skills: agent.skills,
  });
  const provider: ModelProviderPort = {
    id: deps.provider.id, capabilities: deps.provider.capabilities,
    async *stream(request) {
      const call: typeof calls[number] = { step: request.step, text: "", toolCalls: [], linked: false };
      calls.push(call);
      for (const tool of request.tools ?? []) activeTools.set(tool.name, structuredClone(tool));
      for await (const chunk of deps.provider.stream(request)) {
        call.text += chunk.text ?? "";
        if (chunk.toolCalls) call.toolCalls.push(...chunk.toolCalls.map(tool => ({ ...tool, arguments: copyOutput(tool.arguments) })));
        if (chunk.stopReason) call.stopReason = chunk.stopReason;
        yield chunk;
      }
    },
  };
  const allowed = agent.tools === undefined ? undefined : new Set(agent.tools.map(tool => tool.name));
  const filter = (specs: ToolSpec[]) => specs.filter(spec => allowed === undefined || allowed.has(spec.name));
  const tools: ToolProviderPort | undefined = deps.tools ? {
    get tools() { return filter(deps.tools!.tools); },
    listTools: deps.tools.listTools ? async options => filter(await deps.tools!.listTools!(options)) : undefined,
    execute: request => deps.tools!.execute(request),
  } : agent.tools?.length ? {
    tools: agent.tools, async execute() { return { ok: false, error: "no_tool_executor_provided" }; },
  } : undefined;
  const result = await executeTurn({
    ...deps, execution, provider, tools,
    contextBuilder: { async build(request) {
      const context = await baseBuilder.build(request);
      contextPruning = context.pruningReport;
      return context;
    } },
    controlContext: input.controlContext,
    options: { ...agent.options, resume: input.resume },
  }, input);
  let events: AgentStreamEvent[] = [];
  if (result.status !== "skipped") {
    try { events = (await deps.execution.listEvents(input.turnId, eventStart)).filter(event => event.attemptId === input.attemptId && event.sequence > eventStart); }
    catch { warnings.add("final_events_unavailable"); }
  }
  const data = (event: AgentStreamEvent) => (event.data ?? {}) as Record<string, unknown>;
  const text = events.filter(event => event.eventType === "delta").map(event => typeof data(event).text === "string" ? data(event).text : "").join("");
  const reasoning = events.filter(event => event.eventType === "reasoning_delta").map(event => typeof data(event).text === "string" ? data(event).text : "").join("");
  const toolsExecuted = events.filter(event => event.eventType === "tool_result").map(event => {
    const item = data(event);
    return { name: String(item.name ?? "unknown"), ok: item.ok === true, output: item.output, error: typeof item.error === "string" ? item.error : undefined };
  });
  let interruption: AgentRunResult["interruption"];
  if (result.status === "interrupted") {
    const approval = result.reason === "pending_approval" ? events.findLast(event => event.eventType === "tool_approval_required") : undefined;
    if (approval) {
      const item = data(approval);
      interruption = { type: "approval_required", approvalId: String(item.approvalId), toolName: String(item.toolName), argumentsHash: String(item.argumentsHash) };
      if (typeof item.invocationId === "string") outcomes.set(item.invocationId, {
        invocationId: item.invocationId, toolName: String(item.toolName), status: "pending_approval", approvalId: String(item.approvalId),
      });
    } else interruption = { type: result.reason, reason: result.reason };
  }
  const toolExecutions = [...outcomes.values()];
  const manifest: RunDiagnosticsManifest = {
    runId: `run_${input.attemptId}`, turnId: input.turnId, sessionId: input.sessionId, attemptId: input.attemptId,
    startedAt: new Date(startedAt).toISOString(), finishedAt: new Date().toISOString(), durationMs: Date.now() - startedAt,
    status: result.status,
    configuration: {
      persona: { name: agent.persona.name, source: deps.contextBuilder ? "host-context-builder" : "agent-definition" },
      skills: (agent.skills ?? []).map(skill => ({ name: skill.name })),
      tools: { declared: (agent.tools ?? [...activeTools.values()]).map(tool => tool.name),
        active: [...activeTools.values()].map(tool => ({ name: tool.name, readOnly: tool.readOnly, safetyLevel: tool.safetyLevel })) },
      modelRouting: { provider: deps.modelRunMeta?.provider ?? deps.provider.id, modelId: deps.modelRunMeta?.modelId },
    },
    contextPruning, modelSteps, toolExecutions,
    timeBreakdown: { modelLatencyMs: modelSteps.reduce((sum, step) => sum + (step.latencyMs ?? 0), 0),
      toolExecutionMs: toolExecutions.reduce((sum, tool) => sum + (tool.durationMs ?? 0), 0) },
  };
  return { turnId: input.turnId, attemptId: input.attemptId, status: result.status,
    reason: "reason" in result ? result.reason : undefined,
    output: { text, ...(reasoning ? { reasoning } : {}) }, toolsExecuted, interruption,
    diagnostics: { stepsTaken: "stepsTaken" in result ? result.stepsTaken : 0,
      lastSequence: "lastSequence" in result ? result.lastSequence : events.at(-1)?.sequence ?? eventStart,
      manifest, warnings: [...warnings] },
  };
}
