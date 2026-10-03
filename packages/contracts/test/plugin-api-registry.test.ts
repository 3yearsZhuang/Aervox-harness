/**
 * Aervox｜思隅 @aervox/contracts — 插件 API 贡献登记与安全投影（CR-060）
 *
 * 本文件锁定两条不变量：
 * 1. 内核契约源码不含任何插件领域标识 —— 插件事件类型、事件投影与工具结果投影
 *    一律由插件经 `registerPluginApiContribution` 显式登记，内核泛化查表；
 * 2. 投影 fail-closed —— 未登记的事件类型与未登记投影的工具结果都不得原样外泄。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  buildOpenApiDocument,
  getPluginOpenApiRoutes,
  getPluginStreamEventTypes,
  getPluginToolResultProjection,
  getToolResultProjectionOwner,
  isKnownStreamEventType,
  isValidPluginRoutePath,
  projectSafeEventData,
  registerPluginApiContribution,
  registerToolResultProjection,
  resetOpenApiDocumentCache,
  resetPluginApiContributions,
  KERNEL_PROJECTION_EVENT_TYPES,
  KERNEL_STREAM_EVENT_TYPES,
} from "../src/index.js";

const P_event = "fixture_terms_extracted";
const P_tool = "fixture_record";
const P_id = "fixture-plugin";

const termsSchema = z.object({
  turnId: z.string().min(1),
  terms: z.array(z.object({ text: z.string().min(1) })),
});

const toolResultSchema = z.object({
  questionId: z.string(),
  judgement: z.enum(["correct", "incorrect", "partial"]),
});

function registerFixturePlugin(): void {
  registerPluginApiContribution({
    streamEventTypes: [P_event],
    eventProjections: { [P_event]: termsSchema },
    openApiRoutes: [
      {
        method: "post",
        path: "/v1/fixture/explore",
        summary: "fixture 端点",
        tags: ["Fixture"],
        body: z.object({ term: z.string().min(1) }),
        responses: { 200: { description: "ok" } },
      },
    ],
  });
  // CR-060 §B7：工具结果投影由**宿主**为插件自有工具代登记（随工具贡献声明）
  registerToolResultProjection(P_id, P_tool, toolResultSchema);
}

afterEach(() => {
  resetPluginApiContributions();
  resetOpenApiDocumentCache();
  vi.restoreAllMocks();
});

describe("CR-060 插件 API 贡献登记", () => {
  it("默认零插件登记：内核不认识任何插件事件类型", () => {
    expect(getPluginStreamEventTypes()).toEqual([]);
    expect(getPluginOpenApiRoutes()).toEqual([]);
    expect(projectSafeEventData(P_event, { turnId: "t1", terms: [{ text: "闭包" }] })).toEqual({});
  });

  it("登记后可查询事件类型与 OpenAPI 片段，并支持覆盖同一路径", () => {
    registerFixturePlugin();
    expect(getPluginStreamEventTypes()).toContain(P_event);
    expect(getPluginOpenApiRoutes().map((r) => r.path)).toEqual(["/v1/fixture/explore"]);

    registerPluginApiContribution({
      openApiRoutes: [
        { method: "post", path: "/v1/fixture/explore", summary: "覆盖", responses: { 200: { description: "ok" } } },
      ],
    });
    expect(getPluginOpenApiRoutes()).toHaveLength(1);
    expect(getPluginOpenApiRoutes()[0]?.summary).toBe("覆盖");
  });

  it("投影 fail-closed：未登记事件为空对象，登记事件按模式收敛字段", () => {
    registerFixturePlugin();
    // 未登记 → 空对象（不得原样透传）
    expect(projectSafeEventData("never_registered", { secret: "leak" })).toEqual({});
    // 登记但载荷非法 → 空对象
    expect(projectSafeEventData(P_event, { turnId: "", terms: "x" })).toEqual({});
    // 登记且合法 → 只保留白名单字段
    expect(
      projectSafeEventData(P_event, {
        turnId: "t1",
        terms: [{ text: "闭包", internalScore: 0.9 }],
        internalNote: "不应外泄",
      }),
    ).toEqual({ turnId: "t1", terms: [{ text: "闭包" }] });
  });

  it("工具结果投影由宿主代登记：未登记工具不暴露 output，登记工具才附带白名单字段", () => {
    const base = { invocationId: "inv1", name: P_tool, ok: true };
    registerFixturePlugin();

    const projected = projectSafeEventData("tool_result", {
      ...base,
      output: { questionId: "q1", judgement: "correct", enteredMistakeNotebook: true, debug: "x" },
    });
    expect(projected).toEqual({
      invocationId: "inv1",
      name: P_tool,
      ok: true,
      output: { questionId: "q1", judgement: "correct" },
    });

    const otherTool = projectSafeEventData("tool_result", {
      invocationId: "inv2",
      name: "some_other_tool",
      ok: true,
      output: { questionId: "q1" },
    });
    expect(otherTool).not.toHaveProperty("output");
  });

  it("插件登记的 OpenAPI 片段合并进文档，并补齐本地上下文请求头", () => {
    registerFixturePlugin();
    const paths = buildOpenApiDocument().paths as Record<string, Record<string, { parameters?: unknown[] }>>;
    const operation = paths["/v1/fixture/explore"]?.post;
    expect(operation).toBeTruthy();
    expect(operation?.parameters).toEqual(
      expect.arrayContaining([expect.objectContaining({ in: "header", name: "X-Workspace-Id" })]),
    );
  });
});

describe("CR-060：插件流事件类型登记不是装饰", () => {
  it("内核事件全集与投影白名单键集逐项一致（防止两处漂移）", () => {
    expect([...KERNEL_STREAM_EVENT_TYPES].sort()).toEqual([...KERNEL_PROJECTION_EVENT_TYPES].sort());
    // 收敛后的 streamEventTypeSchema 不含工具事件，故全集必须显式覆盖它们
    expect(KERNEL_STREAM_EVENT_TYPES).toContain("tool_request");
    expect(KERNEL_STREAM_EVENT_TYPES).toContain("tool_result");
    for (const kernelEvent of KERNEL_STREAM_EVENT_TYPES) {
      expect(isKnownStreamEventType(kernelEvent), `${kernelEvent} 应为已知内核事件`).toBe(true);
    }
  });


  it("内核事件与已登记插件事件放行，未登记类型拒绝", () => {
    // 内核枚举成员
    expect(isKnownStreamEventType("delta")).toBe(true);
    expect(isKnownStreamEventType("tool_result")).toBe(true);
    // 未登记
    expect(isKnownStreamEventType("plugin_never_registered")).toBe(false);

    registerFixturePlugin();
    expect(isKnownStreamEventType(P_event)).toBe(true);
    // eventProjections 的键同样计入登记（有负载模式的类型必须可写）
    registerPluginApiContribution({ eventProjections: { another_plugin_event: termsSchema } });
    expect(isKnownStreamEventType("another_plugin_event")).toBe(true);
  });
});

describe("CR-060 §B7 工具结果投影归属", () => {
  it("投影归属记录在登记的插件上，未登记的插件无法抢注他人工具", () => {
    registerToolResultProjection("plugin-a", "tool_x", toolResultSchema);
    expect(getToolResultProjectionOwner("tool_x")).toBe("plugin-a");
    expect(getPluginToolResultProjection("tool_x")).toBe(toolResultSchema);
  });

  it("插件 API 不再提供自声明投影入口：同一工具的第二方登记被拒绝（归属冲突 fail-closed）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // 宿主为内核工具登记后，任何其它插件都无法抢注该工具的投影
    registerToolResultProjection("kernel", "ask_user_question", toolResultSchema);
    expect(registerToolResultProjection("plugin-b", "ask_user_question", toolResultSchema)).toBe(false);
    expect(getToolResultProjectionOwner("ask_user_question")).toBe("kernel");
    // 同一归属方重复登记（热重载）允许覆盖
    expect(registerToolResultProjection("kernel", "ask_user_question", toolResultSchema)).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it("内核工具在无投影登记时其 output 不外泄（fail-closed）", () => {
    const projected = projectSafeEventData("tool_result", {
      invocationId: "inv",
      name: "ask_user_question",
      ok: true,
      output: { secret: "不应外泄" },
    });
    expect(projected).not.toHaveProperty("output");
  });
});

describe("CR-060 §B6 插件 OpenAPI 路由不得污染内核契约", () => {
  it("路径判据同时接受 Fastify 参数（:param）与 OpenAPI 占位（{param}），拒绝穿越与查询串", () => {
    // 端点被插件声明两次：OpenAPI 片段用 {param}，宿主挂载用 Fastify 的 :param，二者都必须放行
    expect(isValidPluginRoutePath("/v1/fixture/{reportId}")).toBe(true);
    expect(isValidPluginRoutePath("/v1/fixture/:reportId")).toBe(true);
    expect(isValidPluginRoutePath("/v1/terms/explore")).toBe(true);

    expect(isValidPluginRoutePath("/../etc/passwd")).toBe(false);
    expect(isValidPluginRoutePath("/v2/legacy")).toBe(false);
    expect(isValidPluginRoutePath("/v1/bad?x=1")).toBe(false);
    expect(isValidPluginRoutePath("/v1/bad#frag")).toBe(false);
    expect(isValidPluginRoutePath("v1/relative")).toBe(false);

    registerPluginApiContribution({
      openApiRoutes: [
        { method: "get", path: "/v1/fixture/{reportId}", summary: "openapi 占位", responses: { 200: { description: "ok" } } },
        { method: "get", path: "/v1/fixture/:reportId", summary: "fastify 参数", responses: { 200: { description: "ok" } } },
      ],
    });
    expect(getPluginOpenApiRoutes().map((r) => r.path)).toEqual([
      "/v1/fixture/{reportId}",
      "/v1/fixture/:reportId",
    ]);
  });

  it("非法路径（穿越 / 非 /v1 / 含查询串）在登记阶段即被忽略", () => {    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    registerPluginApiContribution({
      openApiRoutes: [
        { method: "get", path: "/../etc/passwd", summary: "traversal", responses: { 200: { description: "x" } } },
        { method: "get", path: "/v2/legacy", summary: "non-v1", responses: { 200: { description: "x" } } },
        { method: "get", path: "/v1/bad?x=1", summary: "query", responses: { 200: { description: "x" } } },
      ],
    });

    expect(getPluginOpenApiRoutes()).toEqual([]);
    const paths = buildOpenApiDocument().paths ?? {};
    expect(Object.keys(paths).some((p) => p.includes("passwd"))).toBe(false);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("插件路由与内核端点冲突时被忽略，内核对外契约保持不变", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const before = buildOpenApiDocument();
    const baselineSummary = before.paths?.["/v1/sessions"]?.post?.summary;
    const baselineResponses = Object.keys(before.paths?.["/v1/sessions"]?.post?.responses ?? {}).sort();

    registerPluginApiContribution({
      openApiRoutes: [
        {
          method: "post",
          path: "/v1/sessions",
          summary: "PLUGIN HIJACK",
          responses: { 200: { description: "hijacked" } },
        },
      ],
    });
    resetOpenApiDocumentCache();

    const after = buildOpenApiDocument();
    expect(after.paths?.["/v1/sessions"]?.post?.summary).toBe(baselineSummary);
    expect(Object.keys(after.paths?.["/v1/sessions"]?.post?.responses ?? {}).sort()).toEqual(baselineResponses);
    expect(warn).toHaveBeenCalled();
  });

  it("同一方法+路径重复登记时后者生效，但不会重复出现两个操作", () => {
    registerPluginApiContribution({
      openApiRoutes: [{ method: "get", path: "/v1/fixture/dup", summary: "第一次", responses: { 200: { description: "ok" } } }],
    });
    registerPluginApiContribution({
      openApiRoutes: [{ method: "get", path: "/v1/fixture/dup", summary: "第二次", responses: { 200: { description: "ok" } } }],
    });
    expect(getPluginOpenApiRoutes()).toHaveLength(1);
    expect(getPluginOpenApiRoutes()[0]?.summary).toBe("第二次");
  });

  it("重置登记与缓存后，插件路由真正从文档消失（内核注册表不被污染）", () => {
    registerFixturePlugin();
    expect(buildOpenApiDocument().paths?.["/v1/fixture/explore"]).toBeTruthy();

    resetPluginApiContributions();
    resetOpenApiDocumentCache();

    const rebuilt = buildOpenApiDocument();
    expect(rebuilt.paths?.["/v1/fixture/explore"]).toBeUndefined();
    // 内核端点仍在
    expect(rebuilt.paths?.["/v1/sessions"]).toBeTruthy();
  });
});
