/**
 * Aervox｜思隅 @aervox/database — 阶段 5c Subagent 运行关联仓储测试
 *
 * 覆盖 AVX-HAR-001 §13 阶段 5c：
 * - createRun 幂等：同 parentAttemptId + parentExecutionId 返回既有行（崩溃/重试不重复落库）；
 * - finalizeRun：仅 Running 可收口终态（status/resultText/finishedAt）；非 Running 返回 null；
 * - listRunsByTurn：父 Turn 子任务审计列表（租户隔离）；
 * - 租户隔离：跨租户不可见（查/列均按 workspace+subject 绑定）。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteSubagentRunRepository,
  type AervoxDatabase,
  type TenantContext,
} from "../src/index.js";
import type { Client } from "@libsql/client";

const tenantA: TenantContext = { workspaceId: "ws_sub_a", subjectUserId: "usr_sub_a" };
const tenantB: TenantContext = { workspaceId: "ws_sub_b", subjectUserId: "usr_sub_b" };

describe("阶段 5c Subagent 运行关联（subagent_runs）", () => {
  let db: AervoxDatabase;
  let client: Client;
  let repo: SqliteSubagentRunRepository;

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    await initDatabaseSchema(client);
    repo = new SqliteSubagentRunRepository(db);
  });

  const baseInput = {
    id: "subrun_1",
    sessionId: "ses_1",
    parentTurnId: "turn_parent",
    parentAttemptId: "attempt_parent",
    parentExecutionId: "attempt_parent:2:3",
    subTurnId: "turn_sub",
    subAttemptId: "attempt_sub",
    task: "总结前文",
  };

  it("createRun：初始 Running + 溯源字段落库", async () => {
    const run = await repo.createRun(tenantA, baseInput);
    expect(run.status).toBe("Running");
    expect(run.parentAttemptId).toBe("attempt_parent");
    expect(run.parentExecutionId).toBe("attempt_parent:2:3");
    expect(run.subTurnId).toBe("turn_sub");
    expect(run.task).toBe("总结前文");
    expect(run.finishedAt).toBeNull();
  });

  it("createRun 幂等：同父执行键重复创建返回既有行（不新增）", async () => {
    await repo.createRun(tenantA, baseInput);
    const second = await repo.createRun(tenantA, { ...baseInput, id: "subrun_dup", subTurnId: "turn_sub_2" });
    expect(second.id).toBe("subrun_1");
    expect(second.subTurnId).toBe("turn_sub");
    // 且查询面唯一
    const byExec = await repo.getRunByParentExecution(tenantA, "attempt_parent", "attempt_parent:2:3");
    expect(byExec?.id).toBe("subrun_1");
  });

  it("finalizeRun：Running → 终态，写入结果与完成时间；重复收口返回 null", async () => {
    const run = await repo.createRun(tenantA, baseInput);
    const finalized = await repo.finalizeRun(tenantA, run.id, {
      status: "Completed",
      resultText: "子任务正文输出",
    });
    expect(finalized?.status).toBe("Completed");
    expect(finalized?.resultText).toBe("子任务正文输出");
    expect(finalized?.finishedAt).toBeTruthy();
    // 已终态不可再收口（CAS 语义）
    await expect(
      repo.finalizeRun(tenantA, run.id, { status: "Failed", error: "late" }),
    ).resolves.toBeNull();
  });

  it("listRunsByTurn：父 Turn 全部子任务按创建顺序返回；含多执行键", async () => {
    await repo.createRun(tenantA, baseInput);
    await repo.createRun(tenantA, {
      ...baseInput,
      id: "subrun_2",
      parentExecutionId: "attempt_parent:3:1",
      subTurnId: "turn_sub_2",
    });
    const runs = await repo.listRunsByTurn(tenantA, "turn_parent");
    expect(runs.map((r) => r.id)).toEqual(["subrun_1", "subrun_2"]);
  });

  it("租户隔离：跨租户查询/列表不可见", async () => {
    await repo.createRun(tenantA, baseInput);
    await expect(repo.getRunByParentExecution(tenantB, "attempt_parent", "attempt_parent:2:3")).resolves.toBeNull();
    await expect(repo.listRunsByTurn(tenantB, "turn_parent")).resolves.toEqual([]);
    // 终态收口跨租户不可命中
    const run = await repo.getRunByParentExecution(tenantA, "attempt_parent", "attempt_parent:2:3");
    await expect(
      repo.finalizeRun(tenantB, run?.id as string, { status: "Failed" }),
    ).resolves.toBeNull();
    // 收口后 A 租户可见终态
    await repo.finalizeRun(tenantA, run?.id as string, { status: "Completed", resultText: "ok" });
    const after = await repo.listRunsByTurn(tenantA, "turn_parent");
    expect(after[0]?.status).toBe("Completed");
  });
});