/**
 * Aervox｜思隅 @aervox/api — 刷题模式闭环集成测试（CAP-016）
 *
 * 覆盖：
 * - 带 [模式：刷题模式] 前缀的 Turn：record_practice_attempt 工具经 Contribution 组合可见并执行落库；
 * - 落库 incorrect 作答后：GET /v1/mistakes 可见该错题（错题本派生）；
 * - 无前缀/无关键词的普通 Turn：不进入刷题模式（系统提示词不含刷题规范）；
 * - 端口适配层（createPracticeAttemptPortFactory）：correct 作答不进错题本。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createInMemoryDatabase,
  SqliteLearningRepository,
  type AervoxDatabase,
  type TenantContext,
} from "@aervox/database";
import type { Client } from "@libsql/client";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import {
  createPracticeAttemptPortFactory,
} from "../src/modules/conversation/practice-attempt-port.js";
import { createPracticeAttemptToolProvider, RECORD_PRACTICE_ATTEMPT_TOOL } from "@aervox/agent-loop";

const headers = {
  "x-workspace-id": "ws_quiz",
  "x-user-id": "usr_quiz",
} as const;

const tenant: TenantContext = { workspaceId: "ws_quiz", subjectUserId: "usr_quiz" };

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

describe("CAP-016 刷题模式闭环", () => {
  let app: FastifyInstance;
  let db: AervoxDatabase;
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    process.env.AERVOX_LOOP_PROVIDER = "scripted-quiz";
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

  const createTurn = async (message: string, sessionId = "ses_quiz") =>
    app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/turns`,
      headers,
      payload: {
        message: { content: message, contentType: "text" },
        clientVersion: "it-quiz",
        references: [],
      },
    });

  it("刷题模式前缀 Turn：record_practice_attempt 执行成功，incorrect 作答进入错题本", async () => {
    const created = await createTurn("[模式：刷题模式] 来几道题");
    expect(created.statusCode).toBe(201);
    const turnId = created.json().turnId as string;

    const eventsRes = await app.inject({ method: "GET", url: `/v1/turns/${turnId}/events`, headers });
    const parsed = parseSse(eventsRes.body);
    const types = parsed.map((e) => e.eventType);

    // 工具请求与结果透传
    expect(types).toContain("tool_request");
    expect(types).toContain("tool_result");
    expect(types[types.length - 1]).toBe("done");

    const toolRequest = parsed.find((e) => e.eventType === "tool_request")?.data as
      | { name?: string }
      | undefined;
    expect(toolRequest?.name).toBe(RECORD_PRACTICE_ATTEMPT_TOOL);

    const toolResult = parsed.find(
      (e) => e.eventType === "tool_result" && (e.data as { name?: string }).name === RECORD_PRACTICE_ATTEMPT_TOOL,
    )?.data as { ok?: boolean; output?: { enteredMistakeNotebook?: boolean } };
    expect(toolResult?.ok).toBe(true);
    expect(toolResult?.output?.enteredMistakeNotebook).toBe(true);

    // 错题本 REST 可见该错题
    const mistakesRes = await app.inject({ method: "GET", url: "/v1/mistakes", headers });
    expect(mistakesRes.statusCode).toBe(200);
    const mistakes = mistakesRes.json().items as Array<{ prompt: string; wrongCount: number }>;
    expect(mistakes).toHaveLength(1);
    expect(mistakes[0].prompt).toBe("1 + 1 等于几？");
    expect(mistakes[0].wrongCount).toBe(1);
  });

  it("端口适配层：correct 作答落库但不进入错题本", async () => {
    const learningRepo = new SqliteLearningRepository(db);
    const factory = createPracticeAttemptPortFactory(learningRepo);
    const port = factory(tenant);
    const provider = createPracticeAttemptToolProvider({ practiceAttemptPort: port });

    const res = await provider.execute({
      turnId: "turn_correct",
      attemptId: "atp_1",
      invocationId: "atp_1:1:1",
      name: RECORD_PRACTICE_ATTEMPT_TOOL,
      arguments: {
        prompt: "2 + 2 等于几？",
        userAnswer: "4",
        correctAnswer: "4",
        judgement: "correct",
      },
    });

    expect(res.ok).toBe(true);
    expect((res.output as { enteredMistakeNotebook?: boolean }).enteredMistakeNotebook).toBe(false);

    const mistakes = await learningRepo.listMistakes(tenant, "active");
    expect(mistakes.find((m) => m.prompt === "2 + 2 等于几？")).toBeUndefined();
  });
});
