/**
 * Aervox｜思隅 @aervox/api — 第一方插件端到端接线验证（CAP-002 / CAP-007 / CAP-016）
 *
 * CR-060：本文件验证「宿主只提供通用接缝、插件自带实现」的端到端行为：
 * - 插件贡献的工具（`record_practice_attempt`）经 Contribution 组合进入模型工具面并落库；
 * - 工具可见性**随插件启用状态门控**（停用后模型工具面不再持有该工具）；
 * - 插件贡献的 HTTP 端点（概念探索）由宿主适配为真实路由并完成分支会话创建；
 * - 宿主窄端口工厂（`createPluginHostServicesFactory`）按本地上下文完成作答落库。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createInMemoryDatabase,
  SqliteLearningRepository,
  type AervoxDatabase,
  type LocalContext,
} from "@aervox/repositories";
import type { Client } from "@libsql/client";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createPluginHostServicesFactory } from "../src/plugin-host-services.js";

const headers = {
  "x-workspace-id": "ws_focus",
  "x-user-id": "usr_focus",
} as const;

const tenant: LocalContext = { workspaceId: "ws_focus", subjectUserId: "usr_focus" };

interface ParsedEvent {
  sequence: number;
  eventType: string;
  data: Record<string, unknown>;
}

const parseSse = (body: string): ParsedEvent[] =>
  body
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const data = block.split("\n").find((l) => l.startsWith("data: "));
      return data ? (JSON.parse(data.slice(6)) as ParsedEvent) : null;
    })
    .filter((x): x is ParsedEvent => x !== null);

describe("CR-060 第一方插件端到端接线", () => {
  let app: FastifyInstance;
  let db: AervoxDatabase;
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    // 宿主不自建插件领域夹具：该模式名对应的脚本由插件经 replayScripts 贡献
    process.env.AERVOX_LOOP_PROVIDER = "scripted-plugin";
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    cleanup = res.cleanup;
    const built = await buildApp({ db, client });
    app = built.app;
    await app.ready();
  });

  afterEach(async () => {
    delete process.env.AERVOX_LOOP_PROVIDER;
    await app.close();
    await cleanup();
  });

  const createTurn = async (
    message: string,
    sessionId: string,
    metadata?: Record<string, unknown>,
  ) =>
    app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/turns`,
      headers,
      payload: {
        message: { content: message, contentType: "text" },
        clientVersion: "it-focus",
        references: [],
        ...(metadata ? { metadata } : {}),
      },
    });

  const readEvents = async (turnId: string): Promise<ParsedEvent[]> => {
    const res = await app.inject({ method: "GET", url: `/v1/turns/${turnId}/events`, headers });
    return parseSse(res.body);
  };

  it("插件工具进入模型工具面并落库：incorrect 作答进入错题本", async () => {
    const created = await createTurn("请考考我数学题", "ses_focus", { mode: "focus", intent: "quiz" });
    expect(created.statusCode).toBe(201);
    const turnId = created.json().turnId as string;

    const parsed = await readEvents(turnId);
    const types = parsed.map((e) => e.eventType);
    expect(types).toContain("tool_request");
    expect(types).toContain("tool_result");
    expect(types[types.length - 1]).toBe("done");

    const toolRequest = parsed.find((e) => e.eventType === "tool_request")?.data as
      | { name?: string }
      | undefined;
    expect(toolRequest?.name).toBe("record_practice_attempt");

    const toolResult = parsed.find(
      (e) =>
        e.eventType === "tool_result" &&
        (e.data as { name?: string }).name === "record_practice_attempt",
    )?.data as { ok?: boolean; output?: { enteredMistakeNotebook?: boolean } };
    expect(toolResult?.ok).toBe(true);
    expect(toolResult?.output?.enteredMistakeNotebook).toBe(true);

    // 错题本 REST 可见该错题（宿主学习事实真源派生逻辑，未随插件迁出）
    const mistakesRes = await app.inject({ method: "GET", url: "/v1/mistakes", headers });
    expect(mistakesRes.statusCode).toBe(200);
    const mistakes = mistakesRes.json().items as Array<{ prompt: string; wrongCount: number }>;
    expect(mistakes).toHaveLength(1);
    expect(mistakes[0].prompt).toBe("1 + 1 等于几？");
    expect(mistakes[0].wrongCount).toBe(1);
  });

  it("停用插件后模型工具面不再持有该工具，且不产生学习事实", async () => {
    const disableRes = await app.inject({
      method: "PATCH",
      url: "/v1/plugins/focus-mode",
      headers,
      payload: { enabled: false },
    });
    expect(disableRes.statusCode).toBe(200);

    const created = await createTurn("请考考我数学题", "ses_focus_off", {
      mode: "focus",
      intent: "quiz",
    });
    expect(created.statusCode).toBe(201);
    const turnId = created.json().turnId as string;
    const parsed = await readEvents(turnId);

    // 工具未被贡献 → 组合链回落至运行时注册表并判定为未注册工具
    const toolResult = parsed.find(
      (e) =>
        e.eventType === "tool_result" &&
        (e.data as { name?: string }).name === "record_practice_attempt",
    )?.data as { ok?: boolean } | undefined;
    expect(toolResult?.ok).toBe(false);

    const learningRepo = new SqliteLearningRepository(db);
    expect(await learningRepo.listMistakes(tenant, "active")).toHaveLength(0);
  });

  it("插件贡献的 HTTP 端点由宿主适配为真实路由（概念探索 + 分支会话）", async () => {
    const childRes = await app.inject({
      method: "POST",
      url: "/v1/terms/explore",
      headers,
      payload: { term: "闭包", kind: "child" },
    });
    expect(childRes.statusCode).toBe(200);
    const child = childRes.json() as { content: string; relatedQuestions: string[] };
    expect(child.content).toContain("闭包");
    expect(child.relatedQuestions.length).toBeGreaterThan(0);

    const hierRes = await app.inject({
      method: "POST",
      url: "/v1/hierarchy/explore",
      headers,
      payload: { term: "闭包", kind: "related" },
    });
    expect(hierRes.statusCode).toBe(200);

    // 分支端点经宿主 sessions 窄端口创建子会话，插件不接触会话仓储
    const sessionRes = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers,
      payload: { title: "主会话" },
    });
    const sessionId = sessionRes.json().id as string;
    const branchRes = await app.inject({
      method: "POST",
      url: "/v1/terms/explore",
      headers,
      payload: { term: "闭包", kind: "branch", sessionId },
    });
    expect(branchRes.statusCode).toBe(200);
    expect(branchRes.json().childSessionId).toBeTruthy();

    // 非法入参仍由端点契约 fail-closed
    const badRes = await app.inject({
      method: "POST",
      url: "/v1/terms/explore",
      headers,
      payload: { term: "", kind: "child" },
    });
    expect(badRes.statusCode).toBe(400);
  });

  it("停用插件后其 HTTP 端点一并不可用（与模型工具面同判据）", async () => {
    const before = await app.inject({
      method: "POST",
      url: "/v1/terms/explore",
      headers,
      payload: { term: "闭包", kind: "child" },
    });
    expect(before.statusCode).toBe(200);

    const disableRes = await app.inject({
      method: "PATCH",
      url: "/v1/plugins/focus-mode",
      headers,
      payload: { enabled: false },
    });
    expect(disableRes.statusCode).toBe(200);

    const after = await app.inject({
      method: "POST",
      url: "/v1/terms/explore",
      headers,
      payload: { term: "闭包", kind: "child" },
    });
    expect(after.statusCode).toBe(404);

    const reportRes = await app.inject({
      method: "POST",
      url: "/v1/practice-reports",
      headers,
      payload: {
        sessionId: "ses_x",
        totalQuestions: 1,
        correctCount: 1,
        incorrectCount: 0,
      },
    });
    expect(reportRes.statusCode).toBe(404);
  });

  it("宿主窄端口工厂：correct 作答落库但不进入错题本", async () => {
    const services = createPluginHostServicesFactory(db)(tenant);
    const receipt = await services.learningFacts.recordJudgedAnswer({
      turnId: "turn_correct",
      prompt: "2 + 2 等于几？",
      userAnswer: "4",
      correctAnswer: "4",
      judgement: "correct",
      source: "focus-mode",
    });

    expect(receipt.enteredMistakeNotebook).toBe(false);
    const learningRepo = new SqliteLearningRepository(db);
    const mistakes = await learningRepo.listMistakes(tenant, "active");
    expect(mistakes.find((m) => m.prompt === "2 + 2 等于几？")).toBeUndefined();
  });
});
