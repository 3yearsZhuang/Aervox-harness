/**
 * Aervox｜思隅 @aervox/api — 阶段 5c Subagent/Workflow Contribution API 冒烟
 *
 * 覆盖：独立 Tool/Provider Contribution 接线（buildApp options.workflows 透传）+ 端点：
 * - GET /v1/workflows：返回已注册 Workflow 元数据；未注册返回空数组；
 * - GET /v1/turns/:turnId/subagents：子任务审计（仓储已有运行行），租户隔离；
 * - 注册 Workflow 后创建 Turn 仍成功（workflow 工具贡献不破坏 Loop）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createInMemoryDatabase,
  SqliteSubagentRunRepository,
  type AervoxDatabase,
} from "@aervox/database";
import type { WorkflowDefinition } from "@aervox/agent-loop";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import type { Client } from "@libsql/client";

const headers = {
  "x-workspace-id": "ws_subroute",
  "x-user-id": "usr_subroute",
} as const;

const turnPayload = {
  message: { content: "帮我总结一下", contentType: "text" },
  clientVersion: "it-subroute",
  references: [],
};

const workflows: WorkflowDefinition[] = [
  {
    name: "summarize_context",
    description: "两步串联：接收输入 → 返回完成标记",
    steps: [
      { description: "接收输入", execute: async () => ({ ok: true, output: "received" }) },
      { description: "完成", execute: async () => ({ ok: true, output: "done" }) },
    ],
  },
];

describe("阶段 5c Subagent/Workflow Contribution API", () => {
  let app: FastifyInstance;
  let db: AervoxDatabase;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    process.env.AERVOX_LOOP_PROVIDER = "replay";
    const res = await createInMemoryDatabase();
    db = res.db;
    cleanup = res.cleanup;
    const built = await buildApp({ db, client: res.client, workflows });
    app = built.app;
    await app.ready();
  });

  afterEach(async () => {
    delete process.env.AERVOX_LOOP_PROVIDER;
    await app.close();
    await cleanup();
  });

  it("GET /v1/workflows：返回已注册 Workflow 元数据（含步骤描述，不含步骤实现）", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/workflows" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      workflows: [
        { name: "summarize_context", description: "两步串联：接收输入 → 返回完成标记", steps: ["接收输入", "完成"] },
      ],
    });
  });

  it("GET /v1/workflows：未注册返回空数组（退化安全）", async () => {
    const res = await createInMemoryDatabase();
    const plain = await buildApp({ db: res.db, client: res.client });
    try {
      await plain.app.ready();
      const out = await plain.app.inject({ method: "GET", url: "/v1/workflows" });
      expect(out.statusCode).toBe(200);
      expect(out.json()).toEqual({ workflows: [] });
    } finally {
      await plain.app.close();
      await res.cleanup();
    }
  });

  it("GET /v1/turns/:turnId/subagents：返回子任务审计记录且租户隔离", async () => {
    const runRepo = new SqliteSubagentRunRepository(db);
    await runRepo.createRun(
      { workspaceId: "ws_subroute", subjectUserId: "usr_subroute" },
      {
        id: "subrun_api",
        sessionId: "ses_subroute",
        parentTurnId: "turn_api",
        parentAttemptId: "attempt_api",
        parentExecutionId: "attempt_api:2:3",
        subTurnId: "turn_sub_api",
        subAttemptId: "attempt_sub_api",
        task: "总结这段",
      },
    );
    await runRepo.finalizeRun(
      { workspaceId: "ws_subroute", subjectUserId: "usr_subroute" },
      "subrun_api",
      { status: "Completed", resultText: "已总结" },
    );

    const res = await app.inject({ method: "GET", url: "/v1/turns/turn_api/subagents", headers });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0].status).toBe("Completed");
    expect(body.runs[0].resultText).toBe("已总结");

    // 跨租户不可见（空列表而非泄露）
    const other = await app.inject({
      method: "GET",
      url: "/v1/turns/turn_api/subagents",
      headers: { "x-workspace-id": "ws_other", "x-user-id": "usr_other" },
    });
    expect(other.json().runs).toEqual([]);
  });

  it("注册 Workflow 后创建 Turn 仍成功（workflow.run 工具贡献不破坏 Loop）", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions/ses_subroute/turns",
      headers,
      payload: turnPayload,
    });
    expect(created.statusCode).toBe(201);
    const events = await app.inject({
      method: "GET",
      url: `/v1/turns/${created.json().turnId}/events`,
      headers,
    });
    expect(events.statusCode).toBe(200);
    expect(events.body).toContain('"eventType":"done"');
  });
});