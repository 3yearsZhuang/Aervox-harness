/**
 * Aervox｜思隅 @aervox/api — 会话执行管道中间件集合 (Conversation Pipeline Middlewares)
 *
 * 依据 aervox_core_decoupling_plan.md Phase 1：
 * 将原本交织在 agent-executor.ts 中的跨切面逻辑（遥测、危机干预、伴学插件生命周期、主动智能画像）
 * 彻底解耦为标准的 TurnMiddleware，接入 @aervox/host-agent 的通用执行管道。
 */

import type { TurnMiddleware, TurnMiddlewareContext } from "@aervox/host-agent";
import type { ExecuteResult } from "@aervox/agent-loop";
import type { Observability } from "@aervox/observability";
import type { SafetyService } from "../../platform/safety/index.js";
import {
  executeBeforeTurnPlugins,
  executeAfterTurnPlugins,
  type ServerPluginRegistry,
  type BeforeTurnExecutionResult,
  type TurnPluginContext,
} from "../../ecosystem/plugins/index.js";
import type {
  IExtensionRepository,
  IPluginConfigRepository,
  IProactiveProfileRepository,
  LocalContext,
  SqliteConversationRepository,
} from "@aervox/repositories";
import { loadProactiveProfilePrompt } from "../../proactive/proactive/index.js";
import type { LLMCallable } from "@aervox/practice-review";

export const PIPELINE_ATTR_EXTRA_SECTIONS = "pipeline:extra_sections";
export const PIPELINE_ATTR_BEFORE_PLUGINS = "pipeline:before_plugins";
export const PIPELINE_ATTR_PROACTIVE_PROMPT = "pipeline:proactive_prompt";
export const PIPELINE_ATTR_LLM_CALLABLE = "pipeline:llm_callable";

/**
 * 1. 遥测与全链路指标中间件 (TurnMetricsMiddleware)
 */
export function createTurnMetricsMiddleware(deps: { observability?: Observability }): TurnMiddleware {
  return async (ctx: TurnMiddlewareContext, next) => {
    const startTime = Date.now();
    deps.observability?.metrics.emit({
      type: "counter",
      name: "agent.turn.started",
      value: 1,
    });
    deps.observability?.log.info({
      event: "agent.turn.started",
      message: `Turn ${ctx.turnId} started`,
      fields: {
        turnId: ctx.turnId,
        sessionId: ctx.sessionId,
        attemptId: ctx.attemptId,
      },
    });

    const result = await next();
    const durationMs = Date.now() - startTime;

    deps.observability?.metrics.emit({
      type: "histogram",
      name: "agent.provider.duration_ms",
      value: durationMs,
    });

    if (result.status === "completed") {
      deps.observability?.metrics.emit({
        type: "counter",
        name: "agent.turn.completed",
        value: 1,
      });
      deps.observability?.log.info({
        event: "agent.turn.completed",
        message: `Turn ${ctx.turnId} completed in ${durationMs}ms`,
        fields: {
          turnId: ctx.turnId,
          sessionId: ctx.sessionId,
          durationMs,
        },
      });
    } else if (result.status === "failed") {
      deps.observability?.log.error({
        event: "agent.turn.failed",
        message: `Turn ${ctx.turnId} failed: ${result.reason}`,
        fields: {
          turnId: ctx.turnId,
          sessionId: ctx.sessionId,
          durationMs,
          error: result.reason,
        },
      });
    } else if (result.status === "cancelled") {
      deps.observability?.log.warn({
        event: "agent.turn.interrupted",
        message: `Turn ${ctx.turnId} status=${result.status}`,
        fields: {
          turnId: ctx.turnId,
          sessionId: ctx.sessionId,
          durationMs,
          status: result.status,
        },
      });
    } else {
      deps.observability?.log.warn({
        event: "agent.turn.skipped",
        message: `Turn ${ctx.turnId} status=${result.status}`,
        fields: {
          turnId: ctx.turnId,
          sessionId: ctx.sessionId,
          durationMs,
          status: result.status,
        },
      });
    }

    return result;
  };
}

/**
 * 2. 危机安全干预与情绪指引中间件 (SafetyCrisisMiddleware)
 * PRD §4.3、§6.5、SRS FR-SAFE-001
 */
export function createSafetyCrisisMiddleware(deps: {
  safetyService?: SafetyService;
  repo: SqliteConversationRepository;
  tenant: LocalContext;
  broadcastingStore: import("@aervox/host-agent").SqliteExecutionStore;
  observability?: Observability;
}): TurnMiddleware {
  return async (ctx: TurnMiddlewareContext, next) => {
    if (!deps.safetyService || !ctx.userMessage) {
      return next();
    }

    const classification = deps.safetyService.classify(ctx.userMessage);
    if (classification.level === "crisis_high") {
      deps.observability?.metrics.emit({
        type: "counter",
        name: "agent.safety.crisis_intercepted",
        value: 1,
      });
      deps.observability?.log.warn({
        event: "safety.crisis_intercepted",
        message: `Turn ${ctx.turnId} intercepted by crisis safety gate`,
        fields: {
          turnId: ctx.turnId,
          sessionId: ctx.sessionId,
          category: classification.category,
          matchedPatterns: classification.matchedPatterns,
        },
      });
      deps.observability?.audit.emit({
        eventType: "safety.crisis_intercepted",
        action: "intercept_crisis",
        actorId: deps.tenant.subjectUserId ?? "system",
        scope: ctx.turnId,
        payload: {
          sessionId: ctx.sessionId,
          category: classification.category,
          policyVersion: deps.safetyService.getPolicyVersion(),
        },
      }).catch(() => undefined);

      // 1. 脱敏当前 Turn 用户消息
      await deps.repo.redactTurnMessages(deps.tenant, ctx.turnId).catch(() => undefined);

      // 2. 生成固定危机回复并写入
      const crisisText = deps.safetyService.getCrisisResponse();
      const assistantMsgId = `msg_${Date.now().toString(36)}_safe`;
      await deps.repo.appendRedactedAssistantMessage(deps.tenant, {
        id: assistantMsgId,
        turnId: ctx.turnId,
        content: crisisText,
      }).catch(() => undefined);

      // 3. 记录安全事件审计
      await deps.safetyService.recordIncident(deps.tenant, {
        id: `sinc_${ctx.turnId}`,
        category: classification.category,
        severity: "critical",
        disposition: "blocked",
        policyVersion: deps.safetyService.getPolicyVersion(),
      }).catch(() => undefined);

      // 4. 通过 broadcastingStore 广播事件并闭环
      await deps.broadcastingStore.appendEvent({
        turnId: ctx.turnId,
        attemptId: ctx.attemptId,
        sequence: 1,
        eventType: "delta",
        data: { messageId: assistantMsgId, text: crisisText },
        safetyDecision: "redacted",
        expectedFencingToken: 0,
      }).catch(() => undefined);

      await deps.broadcastingStore.appendEvent({
        turnId: ctx.turnId,
        attemptId: ctx.attemptId,
        sequence: 2,
        eventType: "done",
        data: { status: "Completed", messageId: assistantMsgId, isComplete: true, lastSequence: 2 },
        safetyDecision: "approved",
        expectedFencingToken: 0,
      }).catch(() => undefined);

      await deps.broadcastingStore.finalizeAttempt({
        turnId: ctx.turnId,
        attemptId: ctx.attemptId,
        status: "Completed",
      }).catch(() => undefined);

      await deps.broadcastingStore.updateTurnStatus({ turnId: ctx.turnId, status: "Completed" }).catch(() => undefined);

      // 拦截下游模型与工具调用
      return {
        status: "completed",
        attemptId: ctx.attemptId,
        lastSequence: 2,
        stepsTaken: 0,
      };
    }

    if (classification.level === "distress_moderate") {
      deps.observability?.metrics.emit({
        type: "counter",
        name: "agent.safety.distress_guided",
        value: 1,
      });
      deps.observability?.log.info({
        event: "safety.distress_guided",
        message: `Turn ${ctx.turnId} emotional companionship distress guidance injected`,
        fields: { turnId: ctx.turnId, category: classification.category },
      });
      const extraSections = (ctx.attributes.get(PIPELINE_ATTR_EXTRA_SECTIONS) as string[] | undefined) ?? [];
      extraSections.unshift(deps.safetyService.getDistressGuidance());
      ctx.attributes.set(PIPELINE_ATTR_EXTRA_SECTIONS, extraSections);
    }

    return next();
  };
}

/**
 * 3. 伴学插件前后置生命周期中间件 (CompanionPluginLifecycleMiddleware)
 */
export function createCompanionPluginLifecycleMiddleware(deps: {
  pluginRegistry: ServerPluginRegistry;
  repo: SqliteConversationRepository;
  tenant: LocalContext;
  extensionRepo: IExtensionRepository | null;
  pluginConfigRepo?: IPluginConfigRepository;
}): TurnMiddleware {
  return async (ctx: TurnMiddlewareContext, next) => {
    const turnPluginCtx: TurnPluginContext = {
      turnId: ctx.turnId,
      sessionId: ctx.sessionId,
      attemptId: ctx.attemptId,
      userMessage: ctx.userMessage ?? "",
      tenant: deps.tenant,
      repo: deps.repo,
      metadata: ctx.metadata,
    };

    const beforeTurnExec = await executeBeforeTurnPlugins(
      deps.pluginRegistry,
      turnPluginCtx,
      deps.extensionRepo,
      deps.pluginConfigRepo,
    );

    const extraSections = (ctx.attributes.get(PIPELINE_ATTR_EXTRA_SECTIONS) as string[] | undefined) ?? [];
    extraSections.push(...beforeTurnExec.extraSections);
    ctx.attributes.set(PIPELINE_ATTR_EXTRA_SECTIONS, extraSections);
    ctx.attributes.set(PIPELINE_ATTR_BEFORE_PLUGINS, beforeTurnExec);

    const result = await next();

    const llm = ctx.attributes.get(PIPELINE_ATTR_LLM_CALLABLE) as LLMCallable | undefined;
    const finalStatus: "Completed" | "Failed" | "Interrupted" =
      result.status === "completed"
        ? "Completed"
        : result.status === "cancelled"
        ? "Interrupted"
        : "Failed";

    await executeAfterTurnPlugins(
      deps.pluginRegistry,
      { ...turnPluginCtx, status: finalStatus, llm },
      deps.extensionRepo,
      deps.pluginConfigRepo,
      beforeTurnExec.pluginResults,
      beforeTurnExec.snapshots,
    );

    return result;
  };
}

/**
 * 4. 主动智能本地限定与画像注入中间件 (ProactivePolicyMiddleware)
 */
export function createProactivePolicyMiddleware(deps: {
  proactiveRepository?: IProactiveProfileRepository;
  tenant: LocalContext;
}): TurnMiddleware {
  return async (ctx: TurnMiddlewareContext, next) => {
    if (deps.proactiveRepository) {
      const proactiveStatus = await deps.proactiveRepository.getEffectiveStatus(deps.tenant).catch(() => null);
      const proactiveActive = proactiveStatus?.effectiveState === "active";
      if (proactiveActive) {
        // 主动智能生效时，强制要求本地处理限定，不得走云端
        ctx.controlContext = ctx.controlContext.deriveSubtask({ localProcessingOnly: true });
        const prompt = await loadProactiveProfilePrompt(deps.proactiveRepository, deps.tenant).catch(() => "");
        if (prompt) {
          ctx.attributes.set(PIPELINE_ATTR_PROACTIVE_PROMPT, prompt);
        }
      }
    }
    return next();
  };
}
