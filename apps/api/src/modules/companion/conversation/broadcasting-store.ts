/**
 * Aervox｜思隅 @aervox/api — SqliteExecutionStore SSE 广播桥（CR-031 实时流式直推）
 *
 * 机械拆分自 agent-executor.ts（B 档第三步，零行为变更）：
 * 包装 @aervox/host-agent 的 SqliteExecutionStore，落盘 SQLite 的同时把
 * 事件 / 安全分段 / 工具结果同步广播给 turnStreamHub，方法体逐字节迁移。
 */
import { SqliteExecutionStore } from "@aervox/host-agent";
import type {
  LocalContext,
  SqliteConversationRepository,
  SqlitePlatformRepository,
} from "@aervox/repositories";
import { turnStreamHub } from "./stream-hub.js";

import { projectSafeEventData } from "@aervox/contracts";
export { projectSafeEventData } from "@aervox/contracts";

/**
 * 构造会话执行存储与实时广播桥（阶段 7 ModelRun/ContextManifest 委托 + CR-031 直推）
 */
export function createConversationExecutionStore(
  repo: SqliteConversationRepository,
  tenant: LocalContext,
  platformRepo?: SqlitePlatformRepository,
): SqliteExecutionStore {
  const store = new SqliteExecutionStore(
    repo,
    tenant,
    platformRepo
      ? {
          recordModelRun: async (r) => {
            await platformRepo.createModelRun(tenant, {
              id: r.runId,
              attemptId: r.attemptId,
              stepId: r.stepId,
              purpose: r.purpose,
              provider: r.provider,
              modelId: r.modelId,
            });
            await platformRepo.completeModelRun(tenant, r.runId, {
              status: r.status === "completed" ? "completed" : "failed",
              latencyMs: r.latencyMs,
            });
          },
          recordContextManifest: async (m) => {
            await platformRepo.createContextManifest({
              id: m.manifestId,
              modelRunId: m.modelRunId,
              purpose: m.purpose,
              sourceArtifactId: "turn:history",
              sourceRevisionId: "1",
              snapshot: m.snapshot,
            });
            await platformRepo.attachContextManifest(tenant, m.modelRunId, m.manifestId);
          },
        }
      : undefined,
  );
  return createBroadcastingStore(store);
}

/** 包装 SqliteExecutionStore，在落盘 SQLite 的同时同步广播给 turnStreamHub（CR-031 实时流式直推） */
export function createBroadcastingStore(baseStore: SqliteExecutionStore): SqliteExecutionStore {
  return new Proxy(baseStore, {
    get(target, prop, receiver) {
      if (prop === "appendEvent") {
        return async (input: Parameters<SqliteExecutionStore["appendEvent"]>[0]) => {
          const ev = await target.appendEvent(input);
          turnStreamHub.publishEvent(input.turnId, {
            id: ev.eventId,
            turnId: ev.turnId,
            sequence: ev.sequence,
            eventType: ev.eventType,
            payloadVersion: ev.payloadVersion,
            occurredAt: ev.occurredAt,
            data: projectSafeEventData(ev.eventType, ev.data),
          });
          return ev;
        };
      }
      if (prop === "finalizeAttempt") {
        return async (input: Parameters<SqliteExecutionStore["finalizeAttempt"]>[0]) => {
          const res = await target.finalizeAttempt(input);
          if (res.ok) {
            turnStreamHub.publishSettled(input.turnId, input.status);
          }
          return res;
        };
      }
      if (prop === "finalizeAttemptWithEvent") {
        return async (input: Parameters<SqliteExecutionStore["finalizeAttemptWithEvent"]>[0]) => {
          const res = await target.finalizeAttemptWithEvent(input);
          if (res.ok) {
            turnStreamHub.publishEvent(input.turnId, {
              id: `tev_${input.turnId}_${input.sequence}`,
              turnId: input.turnId,
              sequence: input.sequence,
              eventType: input.eventType,
              payloadVersion: 1,
              occurredAt: new Date().toISOString(),
              data: projectSafeEventData(input.eventType, input.eventData),
            });
            turnStreamHub.publishSettled(input.turnId, input.status);
          }
          return res;
        };
      }
      if (prop === "recordSafeSegment") {
        return async (input: Parameters<SqliteExecutionStore["recordSafeSegment"]>[0]) => {
          const res = await target.recordSafeSegment(input);
          if (res.ok) {
            turnStreamHub.publishEvent(input.turnId, {
              id: `tev_${input.turnId}_${input.sequence}`,
              turnId: input.turnId,
              sequence: input.sequence,
              eventType: "delta",
              payloadVersion: 1,
              occurredAt: new Date().toISOString(),
              data: projectSafeEventData("delta", input.eventData),
            });
          }
          return res;
        };
      }
      if (prop === "recordSafeSegments") {
        type SafeSegmentBatchInput = Array<{
          turnId: string;
          attemptId: string;
          sequence: number;
          text: string;
          eventData: unknown;
          safetyDecision: "approved" | "blocked" | "redacted" | "pending";
          expectedFencingToken: number;
        }>;
        const batchTarget = target as SqliteExecutionStore & {
          recordSafeSegments?: (inputs: SafeSegmentBatchInput) => Promise<{ ok: boolean }>;
        };
        return async (inputs: SafeSegmentBatchInput) => {
          // Keep the proxy compatible with an already-built older host package
          // while workspace packages are rebuilt in dependency order.
          const res = batchTarget.recordSafeSegments
            ? await batchTarget.recordSafeSegments(inputs)
            : await (async () => {
                for (const input of inputs) await target.recordSafeSegment(input);
                return { ok: true };
              })();
          if (res.ok) {
            for (const input of inputs) {
              turnStreamHub.publishEvent(input.turnId, {
                id: `tev_${input.turnId}_${input.sequence}`,
                turnId: input.turnId,
                sequence: input.sequence,
                eventType: "delta",
                payloadVersion: 1,
                occurredAt: new Date().toISOString(),
                data: projectSafeEventData("delta", input.eventData),
              });
            }
          }
          return res;
        };
      }
      if (prop === "recordToolOutcome") {
        return async (input: Parameters<SqliteExecutionStore["recordToolOutcome"]>[0]) => {
          const res = await target.recordToolOutcome(input);
          if (res.ok) {
            turnStreamHub.publishEvent(input.turnId, {
              id: `tev_${input.turnId}_${input.sequence}`,
              turnId: input.turnId,
              sequence: input.sequence,
              eventType: "tool_result",
              payloadVersion: 1,
              occurredAt: new Date().toISOString(),
              data: projectSafeEventData("tool_result", input.eventData),
            });
          }
          return res;
        };
      }
      const val = Reflect.get(target, prop, receiver);
      return typeof val === "function" ? val.bind(target) : val;
    },
  });
}
