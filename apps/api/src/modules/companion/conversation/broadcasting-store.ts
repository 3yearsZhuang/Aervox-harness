/**
 * Aervox｜思隅 @aervox/api — SqliteExecutionStore SSE 广播桥（CR-031 实时流式直推）
 *
 * 机械拆分自 agent-executor.ts（B 档第三步，零行为变更）：
 * 包装 @aervox/host-agent 的 SqliteExecutionStore，落盘 SQLite 的同时把
 * 事件 / 安全分段 / 工具结果同步广播给 turnStreamHub，方法体逐字节迁移。
 */
import type { SqliteExecutionStore } from "@aervox/host-agent";
import { turnStreamHub } from "./stream-hub.js";

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
            data: ev.data,
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
              data: input.eventData,
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
              data: input.eventData,
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
                data: input.eventData,
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
              data: input.eventData,
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
