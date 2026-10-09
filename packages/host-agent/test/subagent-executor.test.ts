/**
 * Aervox｜思隅 @aervox/host-agent — SQLite Subagent 委托执行器集成测试（阶段 5c）
 *
 * 覆盖：真实 SQLite 上 createSqliteSubagentPort →
 * - delegate 端到端：创建独立子 turn/attempt 落库（可审计），嵌套执行后终态 Completed、
 *   子任务正文（delta）聚合回 resultText，subagent_runs 行收口；
 * - 幂等：同父执行键（parentAttemptId + parentExecutionId）重复 delegate 复用既有子任务；
 * - 递归防护：childTools 含 subagent_delegate/workflow_run 时 fail-closed 拒绝；
 * - 子任务失败（工具环境缺失 fail-closed）：run 行 Failed + error。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createSqliteSubagentPort } from "../src/index.js";
import { SqliteExecutionStore } from "../src/index.js";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteConversationRepository,
  SqliteSubagentRunRepository,
  type AervoxDatabase,
  type LocalContext,
} from "@aervox/repositories";
import { ControlContext, createScriptedProvider, SUBAGENT_DELEGATE_TOOL } from "@aervox/core";
import type { Client } from "@libsql/client";

const ctx: LocalContext = { workspaceId: "ws_subag", subjectUserId: "usr_subag" };

describe("SqliteSubagentPort（子任务委托执行器）", () => {
  let db: AervoxDatabase;
  let client: Client;
  let repo: SqliteConversationRepository;
  let runRepo: SqliteSubagentRunRepository;
  let gen: () => string;

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    await initDatabaseSchema(client);
    repo = new SqliteConversationRepository(db);
    runRepo = new SqliteSubagentRunRepository(db);
    await repo.getOrCreateSession(ctx, "ses_sub", "子任务测试");
    let n = 0;
    gen = () => `gen_${(n += 1)}`;
  });

  const delegateInput = {
    parentTurnId: "turn_parent",
    parentAttemptId: "attempt_parent",
    parentExecutionId: "attempt_parent:2:3",
    sessionId: "ses_sub",
    task: "总结这段对话",
  };

  it("端到端：子 turn/attempt 落库 + 嵌套执行 Completed + 正文聚合回填", async () => {
    const subagent = createSqliteSubagentPort({
      ctx,
      store: new SqliteExecutionStore(repo, ctx),
      conversationRepo: repo,
      runRepo,
      providerBuilder: () => createScriptedProvider([{ text: "子任务完成：已总结要点", toolCalls: [] }]),
      genId: gen,
    });
    const result = await subagent.delegate(delegateInput);

    expect(result.status).toBe("Completed");
    expect(result.resultText).toBe("子任务完成：已总结要点");
    // 子任务独立落库（turn + attempt）
    const subTurn = await repo.getTurn(ctx, result.subTurnId);
    expect(subTurn?.sessionId).toBe("ses_sub");
    const attempts = await repo.listTurnAttempts(ctx, result.subTurnId);
    expect(attempts.some((a) => a.id === result.subAttemptId && a.status === "Completed")).toBe(true);
    // run 行终态收口
    const runs = await runRepo.listRunsByTurn(ctx, "turn_parent");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("Completed");
    expect(runs[0]?.subTurnId).toBe(result.subTurnId);
  });

  it("parent cancellation prevents child admission; local-only and budget propagate", async () => {
    const control = new ControlContext({ localProcessingOnly: true, callBudget: { maxCalls: 3, usedCalls: 0 } });
    let calls = 0;
    const subagent = createSqliteSubagentPort({ ctx, store: new SqliteExecutionStore(repo, ctx), conversationRepo: repo, runRepo, genId: gen,
      providerBuilder: (input) => { calls++; expect(input.controlContext?.localProcessingOnly).toBe(true); return createScriptedProvider([{ text: "ok" }]); },
    });
    try {
      await subagent.delegate({ ...delegateInput, controlContext: control });
      expect(control.callBudget?.usedCalls).toBe(1);
      control.abort(new Error("cancelled"));
      await expect(subagent.delegate({ ...delegateInput, parentExecutionId: "a:2:4", controlContext: control })).rejects.toThrow("cancelled");
      expect(calls).toBe(1);
      expect(await runRepo.listRunsByTurn(ctx, "turn_parent")).toHaveLength(1);
    } finally { control.dispose(); }
  });

  it("幂等：同父执行键重复 delegate 复用既有子任务，不重复落库", async () => {
    const subagent = createSqliteSubagentPort({
      ctx,
      store: new SqliteExecutionStore(repo, ctx),
      conversationRepo: repo,
      runRepo,
      providerBuilder: () => createScriptedProvider([{ text: "ok", toolCalls: [] }]),
      genId: gen,
    });
    const first = await subagent.delegate(delegateInput);
    const second = await subagent.delegate(delegateInput);
    expect(second.subTurnId).toBe(first.subTurnId);
    const runs = await runRepo.listRunsByTurn(ctx, "turn_parent");
    expect(runs).toHaveLength(1);
    const attempts = await repo.listTurnAttempts(ctx, first.subTurnId);
    expect(attempts.filter((a) => a.status === "Running" || a.status === "Completed")).toHaveLength(1);
  });

  it("递归防护：childTools 含 subagent_delegate 时 delegate 拒绝（fail-closed）", async () => {
    const subagent = createSqliteSubagentPort({
      ctx,
      store: new SqliteExecutionStore(repo, ctx),
      conversationRepo: repo,
      runRepo,
      providerBuilder: () => createScriptedProvider([{ text: "x", toolCalls: [] }]),
      genId: gen,
      childTools: {
        tools: [{ name: SUBAGENT_DELEGATE_TOOL, description: "递归", readOnly: false }],
        async execute() {
          return { ok: false, error: "n/a" };
        },
      },
    });
    await expect(subagent.delegate(delegateInput)).rejects.toThrow(/must not contain subagent_delegate/);
    // 拒绝发生在落库前：无子任务产生
    await expect(runRepo.listRunsByTurn(ctx, "turn_parent")).resolves.toEqual([]);
  });

  it("子任务失败（工具请求但未配置）：run 行 Failed + error，父级可据 error 收敛", async () => {
    const subagent = createSqliteSubagentPort({
      ctx,
      store: new SqliteExecutionStore(repo, ctx),
      conversationRepo: repo,
      runRepo,
      providerBuilder: () =>
        createScriptedProvider([
          { text: "我需要工具", toolCalls: [{ id: "call_sub", name: "notes_search", arguments: {} }] },
        ]),
      genId: gen,
    });
    const result = await subagent.delegate(delegateInput);
    expect(result.status).toBe("Failed");
    expect(result.error).toBe("subagent_failed");
    const runs = await runRepo.listRunsByTurn(ctx, "turn_parent");
    expect(runs[0]?.status).toBe("Failed");
    expect(runs[0]?.error).toBe("subagent_failed");
  });

  it("Attempt 创建失败整体回滚：无孤儿 Turn，重试无唯一键冲突", async () => {
    const subagent = createSqliteSubagentPort({
      ctx,
      store: new SqliteExecutionStore(repo, ctx),
      conversationRepo: repo,
      runRepo,
      providerBuilder: () => createScriptedProvider([{ text: "ok", toolCalls: [] }]),
      genId: gen,
    });
    await client.execute("CREATE TRIGGER fail_sub_attempt BEFORE INSERT ON turn_attempts BEGIN SELECT RAISE(ABORT, 'injected'); END");
    await expect(subagent.delegate(delegateInput)).rejects.toThrow("injected");
    expect(Number((await client.execute("SELECT COUNT(*) AS n FROM turns")).rows[0]!.n)).toBe(0);
    expect(await runRepo.listRunsByTurn(ctx, "turn_parent")).toHaveLength(0);
    await client.execute("DROP TRIGGER fail_sub_attempt");
    const result = await subagent.delegate(delegateInput);
    expect(result.status).toBe("Completed");
    expect(await repo.listTurnAttempts(ctx, result.subTurnId)).toHaveLength(1);
  });

  it("崩溃窗口重放：既有无 Attempt 的子 Turn 被复用并补建 Attempt，不重复落库", async () => {
    const subagent = createSqliteSubagentPort({
      ctx,
      store: new SqliteExecutionStore(repo, ctx),
      conversationRepo: repo,
      runRepo,
      providerBuilder: () => createScriptedProvider([{ text: "ok", toolCalls: [] }]),
      genId: gen,
    });
    await repo.createTurnWithOutbox(
      ctx,
      { id: "turn_crashed", sessionId: "ses_sub", idempotencyKey: "subagent:attempt_parent:2:3" },
      { id: "msg_crashed", content: "总结这段对话" },
    );
    const result = await subagent.delegate(delegateInput);
    expect(result.status).toBe("Completed");
    expect(result.subTurnId).toBe("turn_crashed");
    expect(await repo.listTurnAttempts(ctx, "turn_crashed")).toHaveLength(1);
    const runs = await runRepo.listRunsByTurn(ctx, "turn_parent");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.subTurnId).toBe("turn_crashed");
  });

  it("providerBuilder 拒绝（如本地处理限制）时保留原始失败原因，不再一律 subagent_failed", async () => {
    const subagent = createSqliteSubagentPort({
      ctx,
      store: new SqliteExecutionStore(repo, ctx),
      conversationRepo: repo,
      runRepo,
      providerBuilder: () => {
        throw new Error("proactive_local_provider_required");
      },
      genId: gen,
    });
    const result = await subagent.delegate(delegateInput);
    expect(result.status).toBe("Failed");
    expect(result.error).toBe("proactive_local_provider_required");
    const runs = await runRepo.listRunsByTurn(ctx, "turn_parent");
    expect(runs[0]?.status).toBe("Failed");
    expect(runs[0]?.error).toBe("proactive_local_provider_required");
  });
});
