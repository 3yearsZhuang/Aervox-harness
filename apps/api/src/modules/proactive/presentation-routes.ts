/**
 * Aervox｜思隅 @aervox/api — 主动表现事件 SSE 直推（CR-032 §4.3 第 4 步 / S4）
 *
 * GET /v1/proactive/events — 以 vault proactive_actions 账本为队列（Outbox 模式）：
 * Worker 派发的 proactive_dispatch 动作（executed）即表现事件真源。连接建立时重放
 * 近期事件，随后 400ms tail 轮询增量（跨进程：Worker 写 vault 库，API 读），15s 心跳。
 * 桌面主进程持常驻连接并按 actionId 去重；断线重连由重放恢复。
 */
import type { FastifyInstance } from "fastify";
import type { ProactiveActionModel, SqliteProactiveProfileRepository, LocalContext } from "@aervox/repositories";
import type { ProactivePresentationEvent } from "@aervox/contracts";

const TAIL_POLL_INTERVAL_MS = 400;
const TAIL_HEARTBEAT_MS = 15_000;
/** 桌面端常驻连接的最长持有时间；到期结束由客户端自动重连 */
const TAIL_MAX_DURATION_MS = 12 * 60 * 60 * 1000;
/** 连接建立时重放的近期事件上限 */
const REPLAY_LIMIT = 20;

function toPresentationEvent(action: ProactiveActionModel): ProactivePresentationEvent | null {
  if (action.actionType !== "proactive_dispatch" || action.state !== "executed") return null;
  const outcome = (action.outcome ?? null) as {
    kind?: string;
    pluginId?: string;
    ruleId?: string;
    title?: string;
    message?: string;
    presentation?: {animation?: string; bubblePreset?: string} | null;
  } | null;
  if (!outcome || outcome.kind !== "plugin_dispatch" || !outcome.message) return null;
  return {
    kind: "proactive.presentation",
    actionId: action.id,
    pluginId: outcome.pluginId ?? action.target,
    ruleId: outcome.ruleId ?? "",
    title: outcome.title ?? action.actionType,
    message: outcome.message,
    animation: outcome.presentation?.animation,
    bubblePreset: outcome.presentation?.bubblePreset,
    occurredAt: action.finishedAt ?? action.updatedAt,
  };
}

export function registerProactivePresentationRoutes(
  app: FastifyInstance,
  deps: {profileRepo: SqliteProactiveProfileRepository},
): void {
  app.get("/v1/proactive/events", async (req, reply) => {
    const tenant: LocalContext = {workspaceId: "local", subjectUserId: "local"};
    const origin = (req.headers.origin as string | undefined) ?? "*";
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Credentials": "true",
    });

    let closed = false;
    let tailTimer: ReturnType<typeof setInterval> | undefined;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let maxDurationTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (): void => {
      if (closed) return;
      closed = true;
      if (tailTimer) clearInterval(tailTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (maxDurationTimer) clearTimeout(maxDurationTimer);
      raw.end();
    };
    req.raw.on("close", finish);
    raw.on("close", finish);

    const loadExecuted = async (): Promise<ProactiveActionModel[]> =>
      (await deps.profileRepo.listActions(tenant, {state: "executed", limit: 50}))
        .filter((action) => action.actionType === "proactive_dispatch")
        .sort((left, right) => (left.finishedAt ?? left.updatedAt).localeCompare(right.finishedAt ?? right.updatedAt));

    // 1) 重放近期表现事件（客户端按 actionId 去重）
    const sentActionIds = new Set<string>();
    for (const action of (await loadExecuted()).slice(-REPLAY_LIMIT)) {
      const event = toPresentationEvent(action);
      if (!event) continue;
      sentActionIds.add(action.id);
      raw.write(`id: ${action.id}\n`);
      raw.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    // 2) tail 轮询增量（Worker 进程写入 vault 账本，此处读出海啸面外的少量新增）
    tailTimer = setInterval(() => {
      void (async () => {
        if (closed) return;
        try {
          for (const action of await loadExecuted()) {
            if (sentActionIds.has(action.id)) continue;
            const event = toPresentationEvent(action);
            if (!event) continue;
            sentActionIds.add(action.id);
            raw.write(`id: ${action.id}\n`);
            raw.write(`data: ${JSON.stringify(event)}\n\n`);
          }
        } catch {
          // vault 暂不可读时保持连接，下个节拍重试
        }
      })();
    }, TAIL_POLL_INTERVAL_MS);

    heartbeatTimer = setInterval(() => {
      if (!closed) raw.write(`: ping\n\n`);
    }, TAIL_HEARTBEAT_MS);
    maxDurationTimer = setTimeout(finish, TAIL_MAX_DURATION_MS);
  });
}
