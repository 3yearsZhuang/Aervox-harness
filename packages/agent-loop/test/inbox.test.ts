/**
 * Aervox｜思隅 @aervox/agent-loop — 阶段 5a Inbox 消费集成测试
 *
 * 覆盖 ADR-017 / AVX-HAR-001 §7.1 第 7 项 + §7.2：
 * - executor 在 Step 前 claim next-step inbox 项并注入 contextBuilder；
 * - 注入后 ack（读入即消费）；无 inbox 依赖时行为不变（后向兼容）；
 * - createInboxAwareContextBuilder 把 inbox 项作为追加 user 消息（§7.1 第 7 项次序）；
 * - InMemoryInbox 幂等 / claim 单赢 / 边界过滤。
 */
import { describe, expect, it } from "vitest";
import {
  createInboxAwareContextBuilder,
  createReplayProvider,
  defaultContextBuilder,
  executeTurn,
  InMemoryExecutionStore,
  InMemoryInbox,
} from "../src/index.js";
import type { ContextBuilderPort } from "../src/ports.js";
import type { AgentInboxItem } from "../src/types.js";

const deps = (store: InMemoryExecutionStore, extra: Record<string, unknown> = {}) => ({
  execution: store,
  provider: createReplayProvider(),
  contextBuilder: defaultContextBuilder,
  ...extra,
});

describe("阶段 5a Inbox 消费（executor + builder 集成）", () => {
  it("配置 inbox 时：claim next-step 项注入 context，读入即 ack；事件流契约不变", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "atp_inb_1", turnId: "turn_inb_1" });
    const inbox = new InMemoryInbox();
    await inbox.enqueue({
      idempotencyKey: "idem_steer",
      sessionId: "sess_inb",
      attemptId: "atp_inb_1",
      type: "steer",
      sourceActor: "user",
      payload: { text: "重点讲复习间隔" },
    });

    const captured: AgentInboxItem[][] = [];
    const capturingBuilder: ContextBuilderPort = {
      build(input) {
        captured.push(input.inboxItems ?? []);
        return defaultContextBuilder.build(input);
      },
    };

    const result = await executeTurn(
      deps(store, { inbox, contextBuilder: capturingBuilder }),
      { turnId: "turn_inb_1", sessionId: "sess_inb", attemptId: "atp_inb_1", userMessage: "帮我复习" },
    );
    expect(result.status).toBe("completed");

    // 注入面：context build 接收到 inbox 项
    expect(captured.length).toBeGreaterThan(0);
    expect(captured.flat().map((i) => i.type)).toContain("steer");

    // 读入即 ack：全部 acknowledged
    const items = inbox.list();
    expect(items.every((i) => i.status === "acknowledged")).toBe(true);
  });

  it("注入后 ack：inbox 项不残留 claimed（安全重放闭环）", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "atp_inb_2", turnId: "turn_inb_2" });
    const inbox = new InMemoryInbox();
    await inbox.enqueue({
      idempotencyKey: "idem_inject",
      sessionId: "sess_inb",
      attemptId: "atp_inb_2",
      type: "inject",
      sourceActor: "plugin",
      payload: { text: "今天天气晴" },
    });

    await executeTurn(
      deps(store, { inbox }),
      { turnId: "turn_inb_2", sessionId: "sess_inb", attemptId: "atp_inb_2", userMessage: "hi" },
    );
    expect(inbox.list().every((i) => i.status === "acknowledged")).toBe(true);
  });

  it("未配置 inbox：行为与后向一致（无 inbox 依赖时零变化）", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "atp_inb_3", turnId: "turn_inb_3" });
    const result = await executeTurn(deps(store), {
      turnId: "turn_inb_3",
      sessionId: "sess_inb",
      attemptId: "atp_inb_3",
      userMessage: "x",
    });
    expect(result.status).toBe("completed");
  });

  it("其他 attempt 的 inbox 项不被本 Step 消费（next-step 边界定位）", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: "atp_inb_4", turnId: "turn_inb_4" });
    const inbox = new InMemoryInbox();
    await inbox.enqueue({
      idempotencyKey: "idem_other",
      sessionId: "sess_inb",
      attemptId: "atp_OTHER",
      type: "inject",
      sourceActor: "agent",
      payload: { text: "别处" },
    });
    const captured: AgentInboxItem[][] = [];
    const capturingBuilder: ContextBuilderPort = {
      build(input) {
        captured.push(input.inboxItems ?? []);
        return defaultContextBuilder.build(input);
      },
    };
    await executeTurn(
      deps(store, { inbox, contextBuilder: capturingBuilder }),
      { turnId: "turn_inb_4", sessionId: "sess_inb", attemptId: "atp_inb_4", userMessage: "x" },
    );
    expect(captured.flat()).toHaveLength(0);
    expect(inbox.list().every((i) => i.status === "pending")).toBe(true);
  });
});

describe("createInboxAwareContextBuilder（§7.1 第 7 项注入）", () => {
  it("把 inbox 项作为追加 user 消息前置（附来源与类型标注）", () => {
    const builder = createInboxAwareContextBuilder(defaultContextBuilder);
    const context = builder.build({
      turnId: "turn_1",
      sessionId: "sess_1",
      messages: [{ role: "user", content: "原始问题" }],
      inboxItems: [
        {
          id: "inb_1",
          idempotencyKey: "idem_1",
          sessionId: "sess_1",
          type: "steer",
          orderingSeq: 1,
          sourceActor: "user",
          payload: { text: "强调优先级" },
          status: "claimed",
          consumeBoundary: "next-step",
          createdAt: new Date().toISOString(),
        },
      ],
    });
    expect(context.messages).toHaveLength(2);
    expect(context.messages[0]!.content).toContain("[inbox:steer@user]");
    expect(context.messages[0]!.content).toContain("强调优先级");
    expect(context.messages[1]!.content).toBe("原始问题");
  });
});

describe("InMemoryInbox（ADR-017 语义）", () => {
  it("enqueue 幂等：同 idempotencyKey 返回既有项", async () => {
    const inbox = new InMemoryInbox();
    const a = await inbox.enqueue({
      idempotencyKey: "k1",
      sessionId: "s",
      type: "followup",
      sourceActor: "user",
      payload: "A",
    });
    const b = await inbox.enqueue({
      idempotencyKey: "k1",
      sessionId: "s",
      type: "followup",
      sourceActor: "user",
      payload: "B",
    });
    expect(b.id).toBe(a.id);
    expect(b.payload).toBe("A");
  });

  it("claim 单赢：已 claim 未 ack 不再返回（CAS 语义）", async () => {
    const inbox = new InMemoryInbox();
    await inbox.enqueue({
      idempotencyKey: "k2",
      sessionId: "s",
      attemptId: "atp",
      type: "inject",
      sourceActor: "agent",
      payload: "tip",
    });
    const first = await inbox.claimForConsumption({ sessionId: "s", attemptId: "atp", type: "next-step" });
    expect(first).toHaveLength(1);
    const second = await inbox.claimForConsumption({ sessionId: "s", attemptId: "atp", type: "next-step" });
    expect(second).toHaveLength(0);
  });

  it("followup 默认 next-turn；steer/inject 默认 next-step", async () => {
    const inbox = new InMemoryInbox();
    const followup = await inbox.enqueue({
      idempotencyKey: "k3",
      sessionId: "s",
      type: "followup",
      sourceActor: "user",
      payload: "新问题",
    });
    const steer = await inbox.enqueue({
      idempotencyKey: "k4",
      sessionId: "s",
      attemptId: "atp",
      type: "steer",
      sourceActor: "user",
      payload: "转向",
    });
    expect(followup.consumeBoundary).toBe("next-turn");
    expect(steer.consumeBoundary).toBe("next-step");
  });
});