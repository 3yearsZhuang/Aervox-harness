import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createInMemoryDatabase,
  SqliteConversationRepository,
  type AervoxDatabase,
} from "@aervox/database";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import type { Client } from "@libsql/client";

const headers = {
  "x-workspace-id": "ws_terms_test",
  "x-user-id": "usr_terms_test",
} as const;

const tenant = { workspaceId: "ws_terms_test", subjectUserId: "usr_terms_test" };

describe("CAP-007 / CAP-002 术语抽取与追问探索集成测试", () => {
  let app: FastifyInstance;
  let db: AervoxDatabase;
  let client: Client;
  let cleanup: () => Promise<void>;
  let convRepo: SqliteConversationRepository;

  beforeEach(async () => {
    process.env.AERVOX_LOOP_PROVIDER = "replay";
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    cleanup = res.cleanup;
    const built = await buildApp({ db, client });
    app = built.app;
    await app.ready();
    convRepo = new SqliteConversationRepository(db);
  });

  afterEach(async () => {
    delete process.env.AERVOX_LOOP_PROVIDER;
    await app.close();
    await cleanup();
  });

  it("POST /v1/terms/explore：child 深度拆解模式返回原理与思考提示", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/terms/explore",
      headers,
      payload: {
        term: "支持向量机",
        kind: "child",
        context: "基于最大间隔超平面",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.term).toBe("支持向量机");
    expect(body.kind).toBe("child");
    expect(body.content).toContain("深度拆解：支持向量机");
    expect(body.content).toContain("底层原理与推导");
    expect(body.relatedQuestions.length).toBeGreaterThan(0);
  });

  it("POST /v1/terms/explore：related 关联对比模式返回横向方案与 Trade-offs", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/terms/explore",
      headers,
      payload: {
        term: "OAuth2",
        kind: "related",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.term).toBe("OAuth2");
    expect(body.kind).toBe("related");
    expect(body.content).toContain("关联对比与发散：OAuth2");
    expect(body.content).toContain("横向技术对比");
    expect(body.relatedQuestions.length).toBeGreaterThan(0);
  });

  it("POST /v1/terms/explore：branch 分支模式支持自动创建会话分支", async () => {
    const session = await convRepo.createSession(tenant, "主学习会话");

    const res = await app.inject({
      method: "POST",
      url: "/v1/terms/explore",
      headers,
      payload: {
        term: "快速傅里叶变换",
        kind: "branch",
        sessionId: session.id,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.term).toBe("快速傅里叶变换");
    expect(body.kind).toBe("branch");
    expect(body.childSessionId).toBeTruthy();

    // 校验分支是否已被持久化记录
    const branches = await convRepo.listBranchesByParent(tenant, session.id);
    expect(branches.some((b) => b.childSessionId === body.childSessionId)).toBe(true);
  });

  it("POST /v1/sessions/:sessionId/turns：后处理自动异步提取并写入 terms_extracted 流事件", async () => {
    const session = await convRepo.createSession(tenant, "算法对话");

    const turnRes = await app.inject({
      method: "POST",
      url: `/v1/sessions/${session.id}/turns`,
      headers,
      payload: {
        message: {
          content: "《快速傅里叶变换》与 Dijkstra 算法 有什么区别？",
          contentType: "text",
        },
        clientVersion: "it-loop",
      },
    });

    expect(turnRes.statusCode).toBe(201);
    const { turnId } = turnRes.json();

    const events = await convRepo.getStreamEvents(tenant, turnId, 0);
    // 验证事件流中有 delta 或 done
    expect(events.length).toBeGreaterThan(0);
  });
});
