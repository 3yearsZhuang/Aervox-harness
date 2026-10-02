/**
 * Aervox｜思隅 @aervox/contracts — 插件 API 贡献登记与安全投影（CR-060）
 *
 * 本文件锁定两条不变量：
 * 1. 内核契约源码不含任何插件领域标识 —— 插件事件类型、事件投影与工具结果投影
 *    一律由插件经 `registerPluginApiContribution` 显式登记，内核泛化查表；
 * 2. 投影 fail-closed —— 未登记的事件类型与未登记投影的工具结果都不得原样外泄。
 */
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildOpenApiDocument,
  getPluginOpenApiRoutes,
  getPluginStreamEventTypes,
  projectSafeEventData,
  registerPluginApiContribution,
  resetOpenApiDocumentCache,
  resetPluginApiContributions,
} from "../src/index.js";

const P_event = "fixture_terms_extracted";
const P_tool = "fixture_record";

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
    toolResultProjections: { [P_tool]: toolResultSchema },
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
}

afterEach(() => {
  resetPluginApiContributions();
  resetOpenApiDocumentCache();
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

  it("工具结果投影由插件登记：未登记工具不暴露 output，登记工具才附带白名单字段", () => {
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
