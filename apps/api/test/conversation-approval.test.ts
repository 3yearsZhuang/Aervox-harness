import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createInMemoryDatabase, SqliteConversationRepository, SqliteToolRegistryRepository, type AervoxDatabase } from "@aervox/repositories";
import { buildApp } from "./app-fixture.js";
import type { FastifyInstance } from "fastify";

const headers = {
  "x-workspace-id": "ws_3a",
  "x-user-id": "usr_3a",
} as const;
const tenant = { workspaceId: "ws_3a", subjectUserId: "usr_3a" } as const;

const turnPayload = {
  message: { content: "保存笔记", contentType: "text" },
  clientVersion: "it-3a",
  references: [],
};

const parseSse = (body: string): Array<{ eventType: string; data: { status?: string; isComplete?: boolean; ok?: boolean; approvalId?: string; error?: string } }> =>
  body
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const data = block.split("\n").find((l) => l.startsWith("data: "));
      return data
        ? (JSON.parse(data.slice(6)) as { eventType: string; data: { status?: string; isComplete?: boolean; ok?: boolean; approvalId?: string; error?: string } })
        : null;
    })
    .filter((x): x is { eventType: string; data: { status?: string; isComplete?: boolean; ok?: boolean; approvalId?: string; error?: string } } => x !== null);

describe("Agent Loop 阶段 3a：写工具审批通道", () => {
  let app: FastifyInstance;
  let db: AervoxDatabase;
  let built: Awaited<ReturnType<typeof buildApp>>;
  let cleanup: () => Promise<void>;
  let writes = 0;
  let hold: Promise<void> | undefined;

  beforeEach(async () => {
    writes = 0; hold = undefined;
    process.env.AERVOX_LOOP_PROVIDER = "scripted-write";
    const res = await createInMemoryDatabase();
    db = res.db;
    cleanup = res.cleanup;
    built = await buildApp({ db, client: res.client });
    app = built.app;
    await app.ready();

    const registry = new SqliteToolRegistryRepository(db);
    await registry.registerTool({
      id: "aervox_save_note",
      name: "aervox_save_note",
      description: "保存一条学习笔记（需授权）",
      category: "memory",
      safetyLevel: "write_with_approval",
      requiredPermissions: [],
      inputSchema: { type: "object", properties: { content: { type: "string" } } },
      builtin: false,
      gatingConditions: [],
      priority: 20,
    });
    built.toolRuntime.registerHandler("aervox_save_note", {
      call: async (_t, args) => { writes++; if (hold) await hold; return { saved: true, content: (args as { content?: string }).content ?? "" }; },
    });
  });

  afterEach(async () => {
    delete process.env.AERVOX_LOOP_PROVIDER;
    await app.close();
    await cleanup();
  });

  const createTurn = async (toolApprovalMode?: "ask" | "full_access") =>
    app.inject({
      method: "POST",
      url: "/v1/sessions/ses_3a/turns",
      headers,
      payload: { ...turnPayload, ...(toolApprovalMode ? { toolApprovalMode } : {}) },
    });

  it("未授权写工具：tool_approval_required + done(Interrupted) + 账本 pending_approval", async () => {
    const created = await createTurn();
    expect(created.statusCode).toBe(201);
    const turnId = created.json().turnId as string;

    const events = parseSse((await app.inject({ method: "GET", url: `/v1/turns/${turnId}/events`, headers })).body);
    expect(events.map((e) => e.eventType)).toContain("tool_approval_required");
    expect(events[events.length - 1].eventType).toBe("done");
    expect(events[events.length - 1].data.status).toBe("Interrupted");

    const repo = new SqliteConversationRepository(db);
    const executions = await repo.listToolExecutionsByTurn(tenant, turnId);
    expect(executions[0]).toMatchObject({ name: "aervox_save_note", status: "pending_approval" });
    const approvals = await repo.listToolApprovalsByTurn(tenant, turnId);
    expect(approvals).toHaveLength(1);
    expect(approvals[0].state).toBe("pending");
  });

  it("完全访问：普通写工具自动授权并执行，关闭后不复用自动授权", async () => {
    const created = await createTurn("full_access");
    expect(created.statusCode).toBe(201);
    const turnId = created.json().turnId as string;

    const repo = new SqliteConversationRepository(db);
    const events = parseSse((await app.inject({ method: "GET", url: `/v1/turns/${turnId}/events`, headers })).body);
    expect(events.map((event) => event.eventType)).not.toContain("tool_approval_required");
    expect(events.find((event) => event.eventType === "tool_result")?.data.ok).toBe(true);
    expect(events.at(-1)?.data.status).toBe("Completed");

    const approvals = await repo.listToolApprovalsByTurn(tenant, turnId);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      state: "granted",
      requester: "local",
    });
    expect(approvals[0]!.decidedBy).toBe("permission:full_access:local");

    // 完全访问是 Turn 级策略；恢复 ask 后，同参数不得命中自动授权记录。
    const askTurn = await createTurn("ask");
    const askTurnId = askTurn.json().turnId as string;
    const askEvents = parseSse((await app.inject({ method: "GET", url: `/v1/turns/${askTurnId}/events`, headers })).body);
    expect(askEvents.map((event) => event.eventType)).toContain("tool_approval_required");
    expect(askEvents.at(-1)?.data.status).toBe("Interrupted");
  });

  it("授权后重发：grant → 重发命中 granted 并执行成功", async () => {
    const first = await createTurn();
    const firstTurnId = first.json().turnId as string;

    const repo = new SqliteConversationRepository(db);
    const approvals = await repo.listToolApprovalsByTurn(tenant, firstTurnId);
    const approvalId = approvals[0]!.id;

    const decide = await app.inject({
      method: "POST",
      url: `/v1/turns/${firstTurnId}/tool-approvals`,
      headers,
      payload: { approvalId, decision: "granted", decidedBy: "admin_unit_test" },
    });
    expect(decide.statusCode).toBe(200);
    expect(decide.json().state).toBe("granted");

    // 同 turn SSE 可见 granted 事件
    const events = parseSse((await app.inject({ method: "GET", url: `/v1/turns/${firstTurnId}/events`, headers })).body);
    expect(events.map((e) => e.eventType)).toContain("tool_approval_granted");

    // 重发相同请求（新 turn）→ 命中 granted → 执行
    const retried = await createTurn();
    const retriedTurnId = retried.json().turnId as string;
    const retriedEvents = parseSse((await app.inject({ method: "GET", url: `/v1/turns/${retriedTurnId}/events`, headers })).body);
    const toolResult = retriedEvents.find((e) => e.eventType === "tool_result")?.data;
    expect(toolResult?.ok).toBe(true);
    expect(retriedEvents[retriedEvents.length - 1].data.status).toBe("Completed");

    const executions = await repo.listToolExecutionsByTurn(tenant, retriedTurnId);
    expect(executions[0]).toMatchObject({ name: "aervox_save_note", status: "executed" });
  });

  it("拒绝后重发：deny → 无 granted 匹配，仍挂 pending", async () => {
    const first = await createTurn();
    const firstTurnId = first.json().turnId as string;

    const repo = new SqliteConversationRepository(db);
    const approvalId = (await repo.listToolApprovalsByTurn(tenant, firstTurnId))[0]!.id;

    const decide = await app.inject({
      method: "POST",
      url: `/v1/turns/${firstTurnId}/tool-approvals`,
      headers,
      payload: { approvalId, decision: "denied", decidedBy: "admin_unit_test" },
    });
    expect(decide.json().state).toBe("denied");

    const retried = await createTurn();
    const retriedTurnId = retried.json().turnId as string;
    const retriedEvents = parseSse((await app.inject({ method: "GET", url: `/v1/turns/${retriedTurnId}/events`, headers })).body);
    expect(retriedEvents.map((e) => e.eventType)).toContain("tool_approval_required");
    expect(retriedEvents[retriedEvents.length - 1].data.status).toBe("Interrupted");
  });

  it("白盒审批续跑：grant → 原 Turn 自动以 Attempt 2 续跑完成，无需新建 Turn 重发", async () => {
    const first = await createTurn();
    const firstTurnId = first.json().turnId as string;

    const repo = new SqliteConversationRepository(db);
    const approvals = await repo.listToolApprovalsByTurn(tenant, firstTurnId);
    const approvalId = approvals[0]!.id;

    // 审批前：Attempt 1 为 Interrupted 终态
    const attemptsBefore = await repo.listTurnAttempts(tenant, firstTurnId);
    expect(attemptsBefore).toHaveLength(1);
    expect(attemptsBefore[0]!.status).toBe("Interrupted");

    // 批准操作
    const decide = await app.inject({
      method: "POST",
      url: `/v1/turns/${firstTurnId}/tool-approvals`,
      headers,
      payload: { approvalId, decision: "granted", decidedBy: "admin_unit_test" },
    });
    expect(decide.statusCode).toBe(200);

    // 等待 Attempt 2 续跑完成
    await expect.poll(async () => (await repo.listTurnAttempts(tenant, firstTurnId))[0]?.status).toBe("Completed");

    // 原 Turn 内部 Attempt 2 成功执行，Attempt 1 保持不变（不可变性）
    const attemptsAfter = await repo.listTurnAttempts(tenant, firstTurnId);
    expect(attemptsAfter).toHaveLength(2);
    expect(attemptsAfter[0]!.attempt).toBe(2);
    expect(attemptsAfter[0]!.status).toBe("Completed");
    expect(attemptsAfter[1]!.attempt).toBe(1);
    expect(attemptsAfter[1]!.status).toBe("Interrupted");

    // 同一 Turn 的 SSE 事件流直接包含 tool_result 与 Completed 终态！无需新建 Turn 重发
    const events = parseSse((await app.inject({ method: "GET", url: `/v1/turns/${firstTurnId}/events`, headers })).body);
    expect(events.map((e) => e.eventType)).toContain("tool_result");
    expect(events.at(-1)?.data.status).toBe("Completed");

    // 工具账本已成功收口为 executed
    const executions = await repo.listToolExecutionsByTurn(tenant, firstTurnId);
    expect(executions[0]).toMatchObject({ name: "aervox_save_note", status: "executed" });
  });
  it("重复及并发批准只预留一个续跑 Attempt、执行一次副作用", async () => {
    const turnId = (await createTurn()).json().turnId as string;
    const repo = new SqliteConversationRepository(db);
    const approvalId = (await repo.listToolApprovalsByTurn(tenant, turnId))[0]!.id;
    let release!: () => void;
    hold = new Promise<void>(resolve => { release = resolve; });
    const grant = () => app.inject({method:"POST",url:`/v1/turns/${turnId}/tool-approvals`,headers,payload:{approvalId,decision:"granted"}});
    try {
      const first = await grant();
      await expect.poll(() => writes).toBe(1);
      const repeated = await Promise.all([grant(), grant()]);
      expect(repeated.map(result => result.statusCode)).toEqual([200,200]);
      expect(repeated.map(result => result.json().continuation)).toEqual([first.json().continuation,first.json().continuation]);
      expect(await repo.listTurnAttempts(tenant,turnId)).toHaveLength(2);
      expect(writes).toBe(1);
      const [execution] = await repo.listToolExecutionsByTurn(tenant,turnId);
      expect(execution).toMatchObject({attemptId:first.json().continuation.attemptId,status:"pending"});
      const conflict = await app.inject({method:"POST",url:`/v1/turns/${turnId}/tool-approvals`,headers,payload:{approvalId,decision:"denied"}});
      expect(conflict.statusCode).toBe(409);
      release();
      await expect.poll(async () => (await repo.listTurnAttempts(tenant,turnId))[0]?.status).toBe("Completed");
      const cursor = first.json().continuation.afterEventId;
      const tail = parseSse((await app.inject({method:"GET",url:`/v1/turns/${turnId}/events?after=${cursor}`,headers})).body);
      expect(tail.map(event=>event.eventType)).toContain("tool_result");
      expect(tail.at(-1)?.data.status).toBe("Completed");
      expect(tail.some(event=>event.data.status==="Interrupted")).toBe(false);
      expect(writes).toBe(1);
    } finally { release(); }
  });

  it("拒绝也续跑原 Turn，且不派发工具；不同 Turn 不能消费其审批", async () => {
    const turnId = (await createTurn()).json().turnId as string;
    const repo = new SqliteConversationRepository(db);
    const approvalId = (await repo.listToolApprovalsByTurn(tenant,turnId))[0]!.id;
    const other = await app.inject({method:"POST",url:"/v1/turns/another/tool-approvals",headers,payload:{approvalId,decision:"granted"}});
    expect(other.statusCode).toBe(404);
    expect((await repo.getToolApproval(tenant,approvalId))?.state).toBe("pending");
    const result = await app.inject({method:"POST",url:`/v1/turns/${turnId}/tool-approvals`,headers,payload:{approvalId,decision:"denied"}});
    expect(result.statusCode).toBe(200);
    await expect.poll(async () => (await repo.listTurnAttempts(tenant,turnId))[0]?.status).toBe("Completed");
    expect(writes).toBe(0);
    expect((await repo.listToolExecutionsByTurn(tenant,turnId))[0]).toMatchObject({status:"rejected",error:"tool_approval_denied"});
  });

  it("预留续跑后崩溃恢复为未知结果，重复批准不能重放", async () => {
    const turnId = (await createTurn()).json().turnId as string;
    const repo = new SqliteConversationRepository(db);
    const approvalId = (await repo.listToolApprovalsByTurn(tenant,turnId))[0]!.id;
    const reserved = await repo.decideToolApprovalAndResume(tenant,{turnId,approvalId,decision:"granted",decidedBy:"local"});
    expect(reserved?.continuation).toBeTruthy();
    await repo.recoverExpiredAttempts(built.client, {unclaimedTimeoutMs:-1000});
    expect((await repo.listToolExecutionsByTurn(tenant,turnId))[0]?.status).toBe("outcome_unknown");
    const retried = await app.inject({method:"POST",url:`/v1/turns/${turnId}/tool-approvals`,headers,payload:{approvalId,decision:"granted"}});
    expect(retried.statusCode).toBe(200);
    expect(await repo.listTurnAttempts(tenant,turnId)).toHaveLength(2);
    expect(writes).toBe(0);
  });

  it("不同 Turn 的同参数待决审批各自绑定，不按工具名误选", async () => {
    const firstTurn = (await createTurn()).json().turnId as string;
    const secondTurn = (await createTurn()).json().turnId as string;
    const repo = new SqliteConversationRepository(db);
    const [first] = await repo.listToolApprovalsByTurn(tenant, firstTurn);
    const [second] = await repo.listToolApprovalsByTurn(tenant, secondTurn);
    expect(first?.id).not.toBe(second?.id);
    expect(second?.turnId).toBe(secondTurn);
    const result = await app.inject({method:"POST",url:`/v1/turns/${secondTurn}/tool-approvals`,headers,payload:{approvalId:second!.id,decision:"granted"}});
    expect(result.statusCode).toBe(200);
    await expect.poll(async () => (await repo.listTurnAttempts(tenant,secondTurn))[0]?.status).toBe("Completed");
    expect(writes).toBe(1);
    expect((await repo.getToolApproval(tenant,first!.id))?.state).toBe("pending");
    expect(await repo.listTurnAttempts(tenant,firstTurn)).toHaveLength(1);
  });

  it("旧审批事件缺少新增字段时仍从原意图恢复模型 callId", async () => {
    const turnId = (await createTurn()).json().turnId as string;
    const repo = new SqliteConversationRepository(db);
    const events = await repo.getStreamEvents(tenant,turnId,0);
    const required = events.find(event=>event.eventType==="tool_approval_required")!;
    const {approvalId,toolName,argumentsHash} = required.data as {approvalId:string;toolName:string;argumentsHash:string};
    await built.client.execute({sql:"UPDATE turn_stream_events SET data = ? WHERE id = ?",args:[JSON.stringify({approvalId,toolName,argumentsHash}),required.id]});
    const result = await app.inject({method:"POST",url:`/v1/turns/${turnId}/tool-approvals`,headers,payload:{approvalId,decision:"granted"}});
    expect(result.statusCode).toBe(200);
    await expect.poll(async () => (await repo.listTurnAttempts(tenant,turnId))[0]?.status).toBe("Completed");
    const intent = events.find(event=>event.eventType==="tool_request")!.data as {invocationId:string};
    const output = (await repo.getStreamEvents(tenant,turnId,0)).find(event=>event.eventType==="tool_result")!.data as {invocationId:string};
    expect(output.invocationId).toBe(intent.invocationId);
    expect(writes).toBe(1);
  });

  it("仅更新时间不会改变同一声明和实现的审批身份", async () => {
    const turnId = (await createTurn()).json().turnId as string;
    const repo = new SqliteConversationRepository(db);
    const [original] = await repo.listToolApprovalsByTurn(tenant,turnId);
    const before = (await built.toolRuntime.exportRegistry()).find(tool => tool.id === "aervox_save_note")!;
    await built.client.execute({sql:"UPDATE tool_registrations SET updated_at = ? WHERE id = ?",args:["2099-01-01T00:00:00.000Z","aervox_save_note"]});
    const after = (await built.toolRuntime.exportRegistry()).find(tool => tool.id === "aervox_save_note")!;
    expect(after.updatedAt).not.toBe(before.updatedAt);
    expect(after.approvalRevision).toBe(before.approvalRevision);
    const grant = (approvalId: string) => app.inject({method:"POST",url:`/v1/turns/${turnId}/tool-approvals`,headers,payload:{approvalId,decision:"granted"}});
    expect((await grant(original!.id)).statusCode).toBe(200);
    await expect.poll(async () => (await repo.listTurnAttempts(tenant,turnId))[0]?.status).toBe("Completed");
    expect(await repo.listTurnAttempts(tenant,turnId)).toHaveLength(2);
    expect(await repo.listToolApprovalsByTurn(tenant,turnId)).toHaveLength(1);
    expect(writes).toBe(1);
  });

  it.each(["handler", "declaration"])("%s 修订改变而更新时间不变时，旧审批不能续跑或授权新实现", async change => {
    const turnId = (await createTurn()).json().turnId as string;
    const repo = new SqliteConversationRepository(db);
    const [original] = await repo.listToolApprovalsByTurn(tenant, turnId);
    const before = (await built.toolRuntime.exportRegistry()).find(tool => tool.id === "aervox_save_note")!;
    const handler = { call: async () => { writes++; return { saved: true, implementation: "replacement" }; } };
    if (change === "handler") built.toolRuntime.registerHandler("aervox_save_note", handler);
    else {
      await built.toolRuntime.registerContribution({ id: "aervox_save_note", name: "aervox_save_note",
        description: "保存笔记的新声明", category: "memory", safetyLevel: "write_with_approval",
        requiredPermissions: [], inputSchema: { type: "object", properties: { content: { type: "string", maxLength: 10000 } } },
        builtin: false, gatingConditions: [], priority: 20 }, handler);
      await built.client.execute({ sql: "UPDATE tool_registrations SET updated_at = ? WHERE id = ?",
        args: [before.updatedAt!, "aervox_save_note"] });
    }
    const after = (await built.toolRuntime.exportRegistry()).find(tool => tool.id === "aervox_save_note")!;
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.approvalRevision).not.toBe(before.approvalRevision);
    const grant = (targetTurn: string, approvalId: string) => app.inject({ method: "POST",
      url: `/v1/turns/${targetTurn}/tool-approvals`, headers, payload: { approvalId, decision: "granted" } });
    const rejected = await grant(turnId, original!.id);
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error).toBe("approval_binding_expired");
    expect((await repo.getToolApproval(tenant, original!.id))!.state).toBe("pending");
    expect((await repo.getTurn(tenant, turnId))!.status).toBe("Interrupted");
    expect(await repo.listTurnAttempts(tenant, turnId)).toHaveLength(1);
    expect(writes).toBe(0);

    const freshTurnId = (await createTurn()).json().turnId as string;
    const [fresh] = await repo.listToolApprovalsByTurn(tenant, freshTurnId);
    expect(fresh!.toolVersion).not.toBe(original!.toolVersion);
    expect((await grant(freshTurnId, fresh!.id)).statusCode).toBe(200);
    await expect.poll(async () => (await repo.getTurn(tenant, freshTurnId))!.status).toBe("Completed");
    expect(writes).toBe(1);
    expect((await repo.listToolExecutionsByTurn(tenant, turnId))[0]!.status).toBe("pending_approval");
    expect((await repo.listToolExecutionsByTurn(tenant, freshTurnId))[0]!.status).toBe("executed");
  });

});
