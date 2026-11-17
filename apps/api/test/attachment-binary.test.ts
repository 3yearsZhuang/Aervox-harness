/**
 * Aervox｜思隅 @aervox/api — 多模态输入二进制上传集成测试（CAP-012 扩展）
 *
 * 覆盖：
 * - POST /v1/attachments/binary：原始二进制上传（合法类型/非法类型/空体）
 * - GET /v1/attachments/:id/content：附件回读（Content-Type / 404 / 本地上下文共享）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInMemoryDatabase, SqliteContentRepository, type AervoxDatabase } from "@aervox/repositories";
import { buildApp } from "./app-fixture.js";
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
  let releaseRead: (() => void) | undefined;

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
    releaseRead?.(); releaseRead = undefined;
    vi.restoreAllMocks();
    await app.close();
    await cleanupDb();
    await rm(attachmentsRoot, { recursive: true, force: true });
  });

  async function uploadOverHttp(base: string) {
    const payload = Buffer.from("ATTACHMENT_READ_PRIVATE_CANARY");
    const response = await fetch(`${base}/v1/attachments/binary?fileName=source.png&mediaType=image%2Fpng&purpose=question`, {
      method: "POST", headers: { ...headers, "content-type": "image/png" }, body: payload,
    });
    expect(response.status).toBe(201);
    return { attachment: await response.json() as { id: string; objectKey: string }, payload };
  }

  function suspendContentRead(objectKey: string) {
    const target = path.join(attachmentsRoot, objectKey);
    const originalRead = fs.readFile;
    let entered!: () => void;
    const received = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { releaseRead = resolve; });
    const reader = vi.spyOn(fs, "readFile").mockImplementation(async (file, options) => {
      const bytes = await originalRead(file, options);
      if (file === target) {
        entered();
        await pending;
      }
      return bytes;
    });
    return {
      received,
      release: () => { releaseRead?.(); releaseRead = undefined; },
      restore: () => reader.mockRestore(),
    };
  }

  it("does not release bytes read before a committed attachment deletion over real HTTP", async () => {
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    const { attachment, payload } = await uploadOverHttp(base);
    const held = suspendContentRead(attachment.objectKey);
    const reading = fetch(`${base}/v1/attachments/${attachment.id}/content`, { headers });
    try {
      await held.received;
      const deletion = await fetch(`${base}/v1/attachments/${attachment.id}`, { method: "DELETE", headers });
      expect(deletion.status).toBe(200);
      expect(await deletion.json()).toMatchObject({ id: attachment.id, invalidatedDerivatives: 0 });
      expect((await client.execute({ sql: "SELECT deleted_at FROM attachments WHERE id = ?", args: [attachment.id] })).rows[0]?.deleted_at).not.toBeNull();
      held.release();
      const response = await reading;
      const body = await response.text();
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).not.toBe("image/png");
      expect(body).not.toContain(payload.toString());
    } finally { held.release(); held.restore(); }
  });

  it("refuses an initially deleted attachment before reading its retained file", async () => {
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    const { attachment, payload } = await uploadOverHttp(base);
    const deletion = await fetch(`${base}/v1/attachments/${attachment.id}`, { method: "DELETE", headers });
    expect(deletion.status).toBe(200); await deletion.json();
    const reader = vi.spyOn(fs, "readFile");
    const response = await fetch(`${base}/v1/attachments/${attachment.id}/content`, { headers });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(payload.toString());
    expect(reader).not.toHaveBeenCalled();
  });

  it.each([
    ["object_key", "replacement.png"], ["media_type", "text/plain"],
    ["size", 999], ["created_at", "2026-01-01T00:00:00.000Z"],
  ] as const)("refuses an attachment resource changed during its read (%s)", async (column, value) => {
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    const { attachment, payload } = await uploadOverHttp(base);
    const held = suspendContentRead(attachment.objectKey);
    const reading = fetch(`${base}/v1/attachments/${attachment.id}/content`, { headers });
    try {
      await held.received;
      await client.execute({ sql: `UPDATE attachments SET ${column} = ? WHERE id = ?`, args: [value, attachment.id] });
      held.release();
      const response = await reading;
      const body = await response.text();
      expect(response.status).toBe(404);
      expect(body).not.toContain(payload.toString());
    } finally { held.release(); held.restore(); }
  });

  it("does not release read bytes when the final attachment query fails", async () => {
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    const { attachment, payload } = await uploadOverHttp(base);
    const held = suspendContentRead(attachment.objectKey);
    const reading = fetch(`${base}/v1/attachments/${attachment.id}/content`, { headers });
    try {
      await held.received;
      // Break only the isolated fixture's final SELECT after the original read.
      await client.execute("ALTER TABLE attachments RENAME COLUMN deleted_at TO unavailable_deleted_at");
      held.release();
      const response = await reading;
      const body = await response.text();
      expect(response.status).toBe(500);
      expect(body).not.toContain(payload.toString());
      expect(body).not.toContain("unavailable_deleted_at");
    } finally { held.release(); held.restore(); }
  });

  it("preserves the original content when attachment deletion rolls back", async () => {
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    const { attachment, payload } = await uploadOverHttp(base);
    await client.execute({ sql: "UPDATE attachments SET scan_status = 'clean' WHERE id = ?", args: [attachment.id] });
    await new SqliteContentRepository(db).createParseResult({ workspaceId: "local", subjectUserId: "local" }, {
      id: "retained-parse", attachmentId: attachment.id, parsedText: "explicit fixture result", parseStatus: "completed",
    });
    await client.execute("CREATE TRIGGER fail_invalidate BEFORE UPDATE OF superseded_at ON attachment_parse_results BEGIN SELECT RAISE(ABORT, 'fixture_failure'); END");
    const held = suspendContentRead(attachment.objectKey);
    const reading = fetch(`${base}/v1/attachments/${attachment.id}/content`, { headers });
    try {
      await held.received;
      const deletion = await fetch(`${base}/v1/attachments/${attachment.id}`, { method: "DELETE", headers });
      expect(deletion.status).toBe(500); await deletion.json();
      expect((await client.execute({ sql: "SELECT deleted_at FROM attachments WHERE id = ?", args: [attachment.id] })).rows[0]?.deleted_at).toBeNull();
      expect((await client.execute("SELECT superseded_at FROM attachment_parse_results WHERE id = 'retained-parse'")).rows[0]?.superseded_at).toBeNull();
      held.release();
      const response = await reading;
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("content-length")).toBe(String(payload.byteLength));
      expect(Buffer.from(await response.arrayBuffer())).toEqual(payload);
    } finally { held.release(); held.restore(); }
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
    expect(body.scanStatus).toBe("pending");
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

  it("附件内容可由同一本地实例的兼容上下文回读", async () => {
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
    expect(other.statusCode).toBe(200);
    expect(other.rawPayload.byteLength).toBe(payload.byteLength);

    const missing = await app.inject({
      method: "GET",
      url: "/v1/attachments/att_notexist/content",
      headers,
    });
    expect(missing.statusCode).toBe(404);
  });
});
