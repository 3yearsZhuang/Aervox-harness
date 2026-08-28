/**
 * Aervox｜思隅 @aervox/agent-loop — 三入口并发语义测试（缺陷3加固）
 *
 * 固化 AVX-HAR-001 §3.2/§5.3 + 3b-B fencing/租约 契约：同步路径（executeTurn）、
 * 内嵌 Host（createAgentHost 轮询）与工人恢复路径（attempt-recovery/恢复器）共享
 * 同一 ExecutionStore 时，任一时刻只有一个执行者能获得 Turn 的执行权：
 * - CAS+fencing：后到者 claim 被拒（already_claimed → skipped），事件流唯一；
 * - 租约过期抢占：恢复器以当前 fencing 占用式重新 claim；旧执行者此后的
 *   renew/finalize/claim 全部被 fencing 拒绝（不发生重复副作用/双重终态）；
 * - 占用式续跑（resume）：事件从 lastSequence+1 续序，不重放已提交内容。
 */
import { describe, expect, it } from "vitest";
import {
  defaultContextBuilder,
  executeTurn,
  InMemoryExecutionStore,
} from "../src/index.js";
import type { ModelProviderPort } from "../src/index.js";

const deps = (store: InMemoryExecutionStore) => ({
  execution: store,
  provider: createImmediateProvider(),
  contextBuilder: defaultContextBuilder,
});

function createImmediateProvider(): ModelProviderPort {
  return {
    id: "immediate",
    async *stream() {
      yield { text: "完成", isFinal: true };
    },
  };
}

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

/** 测试钩子：直接强制 Attempt 租约过期（模拟原执行者停摆超租期） */
function expireLease(store: InMemoryExecutionStore, attemptId: string): void {
  const attempts = (store as unknown as { attempts: Map<string, { leaseExpiresAt?: string }> }).attempts;
  const attempt = attempts.get(attemptId);
  if (attempt) attempt.leaseExpiresAt = new Date(0).toISOString();
}

const turnInput = {
  turnId: "turn_1",
  sessionId: "sess_1",
  attemptId: "atp_1",
  userMessage: "你好",
};

describe("三入口并发语义（fencing + 租约）", () => {
  it("并发领取同一 Attempt：仅先者获得执行权，后者 skipped(already_claimed)，事件仅一套", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "atp_1", turnId: "turn_1" });

    const [a, b] = await Promise.all([
      executeTurn(deps(store), { ...turnInput }),
      executeTurn(deps(store), { ...turnInput }),
    ]);

    expect(a.status).toBe("completed");
    expect(b.status).toBe("skipped");
    expect((b as { reason: string }).reason).toBe("already_claimed");

    const events = await store.listEvents("turn_1");
    expect(events.map((e) => e.eventType)).toEqual(["message", "delta", "done"]);
    expect((events[2].data as { status: string }).status).toBe("Completed");
    expect(store.attemptStatus("atp_1")).toBe("Completed");
  });

  it("执行中第二执行者被 fencing 拦截（重复投递安全）：A 挂起时 B claim 失败，A 正常完成", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "atp_1", turnId: "turn_1" });
    const gate = deferred();
    let gated = false;
    // 第一个执行者：claim 后在 stream 挂起（模拟同步路径正在执行）
    const provider: ModelProviderPort = {
      id: "gated",
      async *stream() {
        gated = true;
        await gate.promise;
        yield { text: "完成", isFinal: true };
      },
    };

    const aPromise = executeTurn(
      { execution: store, provider, contextBuilder: defaultContextBuilder },
      { ...turnInput },
    );
    // 等待 A 进入 stream 挂起（此时 A 已持有 claim）
    while (!gated) {
      await new Promise((r) => setTimeout(r, 1));
    }
    await Promise.resolve();

    // 第二个执行者（模拟 Host 轮询同一 Attempt）
    const b = await executeTurn(deps(store), { ...turnInput });
    expect(b.status).toBe("skipped");
    expect((b as { reason: string }).reason).toBe("already_claimed");

    gate.resolve();
    const a = await aPromise;
    expect(a.status).toBe("completed");

    const events = await store.listEvents("turn_1");
    expect(events.map((e) => e.eventType)).toEqual(["message", "delta", "done"]);
    expect(store.attemptStatus("atp_1")).toBe("Completed");
  });

  it("租约过期抢占：恢复器占用式重新 claim 成功；旧执行者 renew/finalize/claim 全部被 fencing 拒绝", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "atp_1", turnId: "turn_1" });

    // 原执行者（同步/Host）先领取
    const first = await store.claimTurnAttempt({
      turnId: "turn_1",
      attemptId: "atp_1",
      expectedFencingToken: 0,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // 原执行者停摆超过租期 → 恢复器以当前 fencing 占用式抢占
    expireLease(store, "atp_1");
    const second = await store.claimTurnAttempt({
      turnId: "turn_1",
      attemptId: "atp_1",
      expectedFencingToken: first.fencingToken,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    // 旧执行者一切操作失效（fencing 已推进）
    expect(
      await store.renewAttemptLease({
        attemptId: "atp_1",
        leaseId: first.leaseId!,
        expectedFencingToken: first.fencingToken,
      }),
    ).toEqual({ ok: false });
    expect(
      await store.finalizeAttempt({
        turnId: "turn_1",
        attemptId: "atp_1",
        status: "Failed",
        expectedFencingToken: first.fencingToken,
      }),
    ).toEqual({ ok: false });
    expect(
      await store.claimTurnAttempt({
        turnId: "turn_1",
        attemptId: "atp_1",
        expectedFencingToken: first.fencingToken,
      }),
    ).toEqual({ ok: false, reason: "already_claimed" });

    // 新执行者独占终态
    expect(
      await store.finalizeAttempt({
        turnId: "turn_1",
        attemptId: "atp_1",
        status: "Completed",
        expectedFencingToken: second.fencingToken,
      }),
    ).toEqual({ ok: true });
    expect(store.attemptStatus("atp_1")).toBe("Completed");
  });

  it("恢复路径占用式续跑：resume 以当前 fencing 重新 claim，事件从 lastSequence+1 续序且不重放", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "atp_1", turnId: "turn_1" });

    // 原执行者已领取并提交了 message 事件（sequence=1），随后停摆
    const first = await store.claimTurnAttempt({
      turnId: "turn_1",
      attemptId: "atp_1",
      expectedFencingToken: 0,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await store.appendEvent({
      turnId: "turn_1",
      attemptId: "atp_1",
      sequence: 1,
      eventType: "message",
      data: { messageId: "msg_a", role: "assistant", contentType: "text", isComplete: false },
      safetyDecision: "approved",
    });

    // 原执行者停摆 → 恢复器占用式续跑（不重放 message，从 lastSequence+1 追加）
    expireLease(store, "atp_1");
    const result = await executeTurn(
      {
        ...deps(store),
        options: {
          resume: {
            expectedFencingToken: first.fencingToken,
            lastSequence: 1,
            lastStep: 0,
            history: [{ role: "user", content: turnInput.userMessage }],
            messageId: "msg_a",
          },
        },
      },
      { ...turnInput },
    );

    expect(result.status).toBe("completed");
    const events = await store.listEvents("turn_1");
    // 续跑不重发 message —— 事件流 = 既有 message + delta + done，序号连续
    expect(events.map((e) => e.eventType)).toEqual(["message", "delta", "done"]);
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect((events[2].data as { status: string }).status).toBe("Completed");
    expect(store.attemptStatus("atp_1")).toBe("Completed");
  });
});