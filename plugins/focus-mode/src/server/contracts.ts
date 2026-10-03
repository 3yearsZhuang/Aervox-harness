/**
 * Aervox｜思隅 plugins/focus-mode — 对外 API 契约贡献（CAP-002 / CAP-007 / CAP-016）
 *
 * CR-060：本插件对外暴露的模式与端点契约**归插件所有**，内核（`@aervox/contracts`）
 * 不含任何插件领域标识。插件在模块加载时经 `registerPluginApiContribution` 显式登记：
 *
 * - `streamEventTypes` + `eventProjections`：插件自有回合流事件（术语抽取）及其对外投影；
 * - `openApiRoutes`：概念探索与练习报告端点的 OpenAPI 片段。
 *
 * 工具结果的对外投影**不在此登记**：它随 `toolContributions` 的工具贡献声明
 * （见 `focus-tools.ts`），由宿主代登记，插件无法为内核/他人工具登记投影。
 */
import { z } from "zod";
import { registerPluginApiContribution } from "@aervox/contracts";
import { extractedTermSchema } from "./terms-extractor.js";

// ============ 回合流事件：术语抽取 ============

/** `terms_extracted` 事件负载（术语结构复用抽取管线的单一来源） */
export const termsExtractedEventDataSchema = z.object({
  turnId: z.string().min(1),
  messageId: z.string().optional(),
  terms: z.array(extractedTermSchema),
});

export type TermsExtractedEventData = z.infer<typeof termsExtractedEventDataSchema>;

/** 插件自有流事件类型（内核枚举之外，经登记表声明） */
export const TERMS_EXTRACTED_EVENT = "terms_extracted";

// ============ 概念探索端点契约 ============

/** 追问探索方向类型 */
export const termExploreKindSchema = z.enum([
  "child",   // 深挖下钻（原理/前置细节）
  "related", // 对比发散（异同/应用场景）
  "branch",  // 分支对话（创建独立分支会话）
]);

/** 追问探索请求体（POST `/v1/terms/explore` 与 POST `/v1/hierarchy/explore`） */
export const termExploreRequestSchema = z.object({
  term: z.string().min(1),
  kind: termExploreKindSchema.default("child"),
  context: z.string().optional(),
  sessionId: z.string().optional(),
});

/** 追问探索响应体 */
export const termExploreResponseSchema = z.object({
  term: z.string(),
  kind: termExploreKindSchema,
  content: z.string(),
  relatedQuestions: z.array(z.string()).default([]),
  childSessionId: z.string().optional(),
});

export type TermExploreKind = z.infer<typeof termExploreKindSchema>;
export type TermExploreRequest = z.infer<typeof termExploreRequestSchema>;
export type TermExploreResponse = z.infer<typeof termExploreResponseSchema>;

// ============ 练习报告端点契约 ============

export const createPracticeReportSchema = z.object({
  sessionId: z.string().min(1),
  totalQuestions: z.number().int().nonnegative(),
  correctCount: z.number().int().nonnegative(),
  incorrectCount: z.number().int().nonnegative(),
  avgTimeSpentSec: z.number().nonnegative().optional(),
  totalHintsUsed: z.number().int().nonnegative().optional(),
  masteryPrediction: z.number().min(0).max(1).optional(),
  biasAssessment: z.string().optional(),
  reportType: z.string().optional(),
});

// ============ 登记 ============

/** 登记本插件对外 API 契约贡献（模块加载时执行，须先于文档生成与请求处理） */
export function registerFocusModeApiContract(): void {
  registerPluginApiContribution({
    streamEventTypes: [TERMS_EXTRACTED_EVENT],
    eventProjections: { [TERMS_EXTRACTED_EVENT]: termsExtractedEventDataSchema },
    openApiRoutes: [
      {
        method: "post",
        path: "/v1/terms/explore",
        summary: "追问探索概念/术语（CAP-007 / CAP-002）",
        description: "支持深挖（child）、对比发散（related）与分支对话（branch）三种追问探索模式",
        tags: ["Focus"],
        body: termExploreRequestSchema,
        responses: {
          200: { description: "探索结果与关联思考问题", schema: termExploreResponseSchema },
          400: { description: "Invalid explore request" },
        },
      },
      {
        method: "post",
        path: "/v1/hierarchy/explore",
        summary: "层级追问探索（CAP-014 / CAP-007）",
        description: "与 `/v1/terms/explore` 同一处理器，语义侧重层级下钻",
        tags: ["Focus"],
        body: termExploreRequestSchema,
        responses: {
          200: { description: "探索结果与关联思考问题", schema: termExploreResponseSchema },
          400: { description: "Invalid explore request" },
        },
      },
      {
        method: "post",
        path: "/v1/practice-reports",
        summary: "创建自适应练习报告",
        tags: ["Focus"],
        body: createPracticeReportSchema,
        responses: {
          201: { description: "Created" },
          400: { description: "Validation failed" },
        },
      },
      {
        method: "get",
        path: "/v1/practice-reports/{reportId}",
        summary: "读取自适应练习报告",
        tags: ["Focus"],
        params: z.object({ reportId: z.string().min(1) }),
        responses: {
          200: { description: "Report" },
          404: { description: "Report not found" },
        },
      },
      {
        method: "get",
        path: "/v1/practice-sessions/{sessionId}/reports",
        summary: "列出会话练习报告",
        tags: ["Focus"],
        params: z.object({ sessionId: z.string().min(1) }),
        responses: { 200: { description: "Reports" } },
      },
      {
        method: "post",
        path: "/v1/practice-sessions/{sessionId}/reset-inference",
        summary: "重置会话报告推断（保留原始作答）",
        tags: ["Focus"],
        params: z.object({ sessionId: z.string().min(1) }),
        responses: {
          201: { description: "Reset report" },
        },
      },
    ],
  });
}
