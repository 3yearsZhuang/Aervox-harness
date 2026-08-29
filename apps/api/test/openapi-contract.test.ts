import { describe, expect, it } from "vitest";
import { openApiDocument } from "@aervox/contracts";

describe("Learning OpenAPI 契约", () => {
  it("将作答幂等键声明为请求头，并区分首次写入与重试响应", () => {
    const operation = openApiDocument.paths["/v1/questions/{questionId}/attempts"]?.post;

    expect(operation?.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({
        in: "header",
        name: "Idempotency-Key",
        required: false,
      }),
    ]));
    expect(operation?.responses).toEqual(expect.objectContaining({
      200: expect.objectContaining({ description: "Existing idempotent attempt" }),
      201: expect.objectContaining({ description: "Attempt created" }),
    }));
  });

  it("声明活跃练习会话恢复及重复启动的响应", () => {
    const createSession = openApiDocument.paths["/v1/practice/sessions"]?.post;
    const activeSession = openApiDocument.paths["/v1/practice/sessions/active"]?.get;

    expect(createSession?.responses).toEqual(expect.objectContaining({
      200: expect.objectContaining({ description: "Resumed active session" }),
      201: expect.objectContaining({ description: "Created" }),
    }));
    expect(activeSession?.responses).toEqual(expect.objectContaining({
      200: expect.objectContaining({ description: "Active practice session" }),
      404: expect.anything(),
    }));
  });

  it("声明错因字段、筛选参数与可选的错题更新请求", () => {
    const list = openApiDocument.paths["/v1/mistakes"]?.get;
    const update = openApiDocument.paths["/v1/mistakes/{questionId}"]?.patch;
    const mistake = openApiDocument.components?.schemas?.MistakeItem;

    expect(list?.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ in: "query", name: "reasonCode", required: false }),
    ]));
    expect(update?.summary).toBe("更新错题处置或错因");
    expect(mistake).toEqual(expect.objectContaining({
      properties: expect.objectContaining({ reasonCode: expect.anything(), note: expect.anything() }),
    }));
  });

  it("声明练习报告与学习计划的读取和调整端点", () => {
    expect(openApiDocument.paths["/v1/practice-reports"]?.post?.responses).toHaveProperty("201");
    expect(openApiDocument.paths["/v1/practice-sessions/{sessionId}/reports"]?.get?.responses).toHaveProperty("200");
    expect(openApiDocument.paths["/v1/learning-plans"]?.get?.responses).toHaveProperty("200");
    expect(openApiDocument.paths["/v1/learning-plans/generate"]?.post?.responses).toHaveProperty("201");
  });
  it('声明日记查询与写工具授权端点（CAP-009 / PET-05）', () => {
    const diaries = openApiDocument.paths['/v1/diaries']?.get;
    expect(diaries?.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ in: 'query', name: 'localDate', required: true }),
    ]));
    expect(diaries?.responses).toEqual(expect.objectContaining({
      200: expect.anything(),
      400: expect.anything(),
      404: expect.anything(),
    }));

    const approvals = openApiDocument.paths['/v1/turns/{turnId}/tool-approvals']?.post;
    expect(approvals?.responses).toEqual(expect.objectContaining({
      200: expect.anything(),
      403: expect.anything(),
    }));
  });
});
