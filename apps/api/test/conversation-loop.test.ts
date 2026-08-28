import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createInMemoryDatabase, SqliteSkillRegistryRepository, type AervoxDatabase } from "@aervox/database";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import type { Client } from "@libsql/client";

const headers = {
  "x-workspace-id": "ws_loop",
  "x-user-id": "usr_loop",
} as const;

const turnPayload = {
  message: { content: "帮我排一下三天的复习计划", contentType: "text" },
  clientVersion: "it-loop",
  references: [],
};

interface ParsedEvent {
  eventId: string;
  turnId: string;
  sequence: number;
  eventType: string;
  data: {
    status?: string;
    isComplete?: boolean;
    text?: string;
    isFinal?: boolean;
    messageId?: string;
  };
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

describe("Agent Loop 阶段 1：Turn 创建 → 持久事件 → SSE 重放", () => {
  let app: FastifyInstance;
  let db: AervoxDatabase;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    process.env.AERVOX_LOOP_PROVIDER = "replay";
    const res = await createInMemoryDatabase();
    db = res.db;
    cleanup = res.cleanup;
    const built = await buildApp({ db, client: res.client });
    app = built.app;
    await app.ready();
  });

  afterEach(async () => {
    delete process.env.AERVOX_LOOP_PROVIDER;
    await app.close();
    await cleanup();
  });

  const createTurn = async (sessionId = "ses_loop") =>
    app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/turns`,
      headers,
      payload: turnPayload,
    });

  it("POST turn 后 GET events 返回 message → delta* → done，且正文来自持久事件而非模型直通", async () => {
    const created = await createTurn();
    expect(created.statusCode).toBe(201);
    const turnId = created.json().turnId as string;

    const events = await app.inject({
      method: "GET",
      url: `/v1/turns/${turnId}/events`,
      headers,
    });
    expect(events.statusCode).toBe(200);

    const parsed = parseSse(events.body);
    expect(parsed.length).toBeGreaterThanOrEqual(3);
    const types = parsed.map((e) => e.eventType);
    expect(types[0]).toBe("message");
    expect(types[types.length - 1]).toBe("done");
    expect(types.slice(1, -1).every((t) => t === "delta")).toBe(true);

    // 序号从 1 连续递增
    parsed.forEach((e, i) => expect(e.sequence).toBe(i + 1));

    // message 身份事件与 done 终态
    expect(parsed[0].data.messageId).toBeTruthy();
    const done = parsed[parsed.length - 1];
    expect(done.data.status).toBe("Completed");
    expect(done.data.isComplete).toBe(true);

    // delta 内容为 Replay fixture 分块（安全门 approved 后才落库）
    const deltas = parsed.filter((e) => e.eventType === "delta");
    expect(deltas[0].data.text).toContain("收到！");
    expect(deltas[deltas.length - 1].data.isFinal).toBe(true);
  });

  it("重复 GET events 幂等重放同一事件序列（断线重连可恢复）", async () => {
    const created = await createTurn();
    const turnId = created.json().turnId as string;
    const url = `/v1/turns/${turnId}/events`;

    const first = await app.inject({ method: "GET", url, headers });
    const second = await app.inject({ method: "GET", url, headers });

    expect(first.body).toBe(second.body);
    expect(first.body).toContain('"eventType":"done"');
  });

it("阶段 5b：注册 active Skill 后创建 Turn 仍成功（skillLoader 接线不破坏 Loop）", async () => {
    const skillRepo = new SqliteSkillRegistryRepository(db);
    await skillRepo.registerSkill({
      id: "notes-search",
      name: "notes-search",
      description: "搜索学习笔记（渐进披露清单）",
      source: "builtin",
      active: true,
      readonly: false,
    });

    const created = await createTurn();
    expect(created.statusCode).toBe(201);
    const turnId = created.json().turnId as string;
    const events = await app.inject({
      method: "GET",
      url: `/v1/turns/${turnId}/events`,
      headers,
    });
    expect(events.statusCode).toBe(200);
    expect(events.body).toContain('"eventType":"done"');
  });

  it("GET events 携带 CORS 响应头，允许 Web 前端跨域流式订阅", async () => {
    const created = await createTurn();
    const turnId = created.json().turnId as string;
    const url = `/v1/turns/${turnId}/events`;

    const res = await app.inject({
      method: "GET",
      url,
      headers: {
        ...headers,
        origin: "http://localhost:5173",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });
});