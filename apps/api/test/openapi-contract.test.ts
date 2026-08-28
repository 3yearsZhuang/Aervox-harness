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
});
