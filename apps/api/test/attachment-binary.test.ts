/**
 * Aervox｜思隅 @aervox/api — 多模态输入二进制上传集成测试（CAP-012 扩展）
 *
 * 覆盖：
 * - POST /v1/attachments/binary：原始二进制上传（合法类型/非法类型/空体）
 * - GET /v1/attachments/:id/content：附件回读（Content-Type / 404 / 租户隔离）
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInMemoryDatabase, type AervoxDatabase } from "@aervox/database";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import type { Client } from "@libsql/client";

const headers = {
  "x-workspace-id": "ws_att_bin",
  "x-user-id": "usr_att_bin",
} as const;

const otherHeaders = {
  "x-workspace-id": "ws_other",
  "x-user-id": "usr_other",
} as const;

describe("多模态输入：原始二进制上传（CAP-012 扩展）", () => {
  let app: FastifyInstance;
  let db: AervoxDatabase;
  let client: Client;
  let cleanupDb: () => Promise<void>;
  let attachmentsRoot: string;

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    cleanupDb = res.cleanup;
    attachmentsRoot = await mkdtemp(path.join(tmpdir(), "aervox-att-"));
    const built = await buildApp({ db, client, attachmentsRoot });
    app = built.app;
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await cleanupDb();
    await rm(attachmentsRoot, { recursive: true, force: true });
  });

  it("上传图片二进制成功并登记附件记录", async () => {
    const payload = Buffer.from("fake-png-bytes");
    const res = await app.inject({
      method: "POST",
      url: "/v1/attachments/binary?fileName=question.png&mediaType=image%2Fpng&purpose=question",
      headers: { ...headers, "content-type": "image/png" },
      payload,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toMatch(/^att_/);
    expect(body.mediaType).toBe("image/png");
    expect(body.size).toBe(payload.byteLength);
    expect(body.scanStatus).toBe("clean");
    expect(body.purpose).toBe("question");
  });

  it("上传音频与文档类型（多模态扩展枚举）", async () => {
    for (const [mediaType, fileName] of [
      ["audio/mpeg", "voice.mp3"],
      ["audio/wav", "record.wav"],
      ["text/markdown", "notes.md"],
      ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "doc.docx"],
    ] as const) {
      const res = await app.inject({
        method: "POST",
        url: `/v1/attachments/binary?fileName=${encodeURIComponent(fileName)}&mediaType=${encodeURIComponent(mediaType)}&purpose=file`,
        headers: { ...headers, "content-type": mediaType },
        payload: Buffer.from("x"),
      });
      expect(res.statusCode, `${mediaType} should be accepted`).toBe(201);
    }
  });

  it("非法媒体类型与非法 purpose 拒绝", async () => {
    const badType = await app.inject({
      method: "POST",
      url: "/v1/attachments/binary?fileName=clip.mp4&mediaType=video%2Fmp4&purpose=question",
      headers: { ...headers, "content-type": "video/mp4" },
      payload: Buffer.from("x"),
    });
    expect(badType.statusCode).toBe(400);
    expect(badType.json().allowedFormats).toContain("image/png");

    const badPurpose = await app.inject({
      method: "POST",
      url: "/v1/attachments/binary?fileName=a.png&mediaType=image%2Fpng&purpose=oops",
      headers: { ...headers, "content-type": "image/png" },
      payload: Buffer.from("x"),
    });
    expect(badPurpose.statusCode).toBe(400);

    const empty = await app.inject({
      method: "POST",
      url: "/v1/attachments/binary?fileName=a.png&mediaType=image%2Fpng&purpose=question",
      headers: { ...headers, "content-type": "image/png" },
      payload: Buffer.alloc(0),
    });
    expect(empty.statusCode).toBe(400);
  });

  it("附件内容可回读且租户隔离", async () => {
    const payload = Buffer.from("fake-png-bytes-2");
    const create = await app.inject({
      method: "POST",
      url: "/v1/attachments/binary?fileName=chart.png&mediaType=image%2Fpng&purpose=chart",
      headers: { ...headers, "content-type": "image/png" },
      payload,
    });
    expect(create.statusCode).toBe(201);
    const attachmentId = create.json().id;

    const content = await app.inject({
      method: "GET",
      url: `/v1/attachments/${attachmentId}/content`,
      headers,
    });
    expect(content.statusCode).toBe(200);
    expect(content.headers["content-type"]).toBe("image/png");
    expect(content.rawPayload.byteLength).toBe(payload.byteLength);

    const other = await app.inject({
      method: "GET",
      url: `/v1/attachments/${attachmentId}/content`,
      headers: otherHeaders,
    });
    expect(other.statusCode).toBe(404);

    const missing = await app.inject({
      method: "GET",
      url: "/v1/attachments/att_notexist/content",
      headers,
    });
    expect(missing.statusCode).toBe(404);
  });
});
