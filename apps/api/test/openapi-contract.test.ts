import { beforeAll, describe, expect, it } from "vitest";
import { buildOpenApiDocument, resetOpenApiDocumentCache } from "@aervox/contracts";
import { assembleFirstPartyPlugins } from "../src/plugin-assembly.js";

/**
 * CR-060：内核文档只声明内核端点；插件端点在宿主装配阶段经
 * `registerPluginApiContribution({ openApiRoutes })` 登记后由内核泛化补全。
 * 因此断言插件端点前必须先跑一次真实装配（不硬编码插件 id）。
 */
beforeAll(async () => {
  await assembleFirstPartyPlugins({
    turnRegistry: { register: () => () => undefined, get: () => undefined, getAll: () => [] },
  });
  resetOpenApiDocumentCache();
});

describe("Learning OpenAPI 契约", () => {
  it("将作答幂等键声明为请求头，并区分首次写入与重试响应", () => {
    const operation = buildOpenApiDocument().paths["/v1/questions/{questionId}/attempts"]?.post;

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
    const createSession = buildOpenApiDocument().paths["/v1/practice/sessions"]?.post;
    const activeSession = buildOpenApiDocument().paths["/v1/practice/sessions/active"]?.get;

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
    const list = buildOpenApiDocument().paths["/v1/mistakes"]?.get;
    const update = buildOpenApiDocument().paths["/v1/mistakes/{questionId}"]?.patch;
    const mistake = buildOpenApiDocument().components?.schemas?.MistakeItem;

    expect(list?.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ in: "query", name: "reasonCode", required: false }),
    ]));
    expect(update?.summary).toBe("更新错题处置或错因");
    expect(mistake).toEqual(expect.objectContaining({
      properties: expect.objectContaining({ reasonCode: expect.anything(), note: expect.anything() }),
    }));
  });

  it("声明学习计划的读取和调整端点（内核端点）", () => {
    expect(buildOpenApiDocument().paths["/v1/learning-plans"]?.get?.responses).toHaveProperty("200");
    expect(buildOpenApiDocument().paths["/v1/learning-plans/generate"]?.post?.responses).toHaveProperty("201");
  });

  it("声明第一方插件登记的报告与概念探索端点（装配后泛化补全）", () => {
    const paths = buildOpenApiDocument().paths;
    expect(paths["/v1/practice-reports"]?.post?.responses).toHaveProperty("201");
    expect(paths["/v1/practice-reports/{reportId}"]?.get?.responses).toHaveProperty("404");
    expect(paths["/v1/practice-sessions/{sessionId}/reports"]?.get?.responses).toHaveProperty("200");
    expect(paths["/v1/practice-sessions/{sessionId}/reset-inference"]?.post?.responses).toHaveProperty("201");
    expect(paths["/v1/terms/explore"]?.post?.responses).toHaveProperty("200");
    // 插件端点与内核端点一样补齐本地上下文请求头
    expect(paths["/v1/terms/explore"]?.post?.parameters).toEqual(
      expect.arrayContaining([expect.objectContaining({ in: "header", name: "X-Workspace-Id" })]),
    );
  });
  it('声明日记查询与写工具授权端点（CAP-009 / PET-05）', () => {
    const diaries = buildOpenApiDocument().paths['/v1/diaries']?.get;
    expect(diaries?.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ in: 'query', name: 'localDate', required: true }),
    ]));
    expect(diaries?.responses).toEqual(expect.objectContaining({
      200: expect.anything(),
      400: expect.anything(),
      404: expect.anything(),
    }));

    const approvals = buildOpenApiDocument().paths['/v1/turns/{turnId}/tool-approvals']?.post;
    expect(approvals?.responses).toEqual(expect.objectContaining({
      200: expect.anything(),
      403: expect.anything(),
    }));
  });
});
