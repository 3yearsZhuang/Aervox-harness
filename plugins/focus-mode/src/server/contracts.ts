/**
 * Aervox｜思隅 plugins/focus-mode — 对外 API 契约贡献（CAP-002 / CAP-007 / CAP-016）
 *
 * CR-060：本插件对外暴露的模式与端点契约**归插件所有**，内核（`@aervox/contracts`）
 * 不含任何插件领域标识。插件在宿主装配时经 `registerPluginApiContribution` 显式登记：
 *
 * - `streamEventTypes` + `eventProjections`：插件自有回合流事件（术语抽取）及其对外投影；
 * - `openApiRoutes`：概念探索与练习报告端点的 OpenAPI 片段。
 *
 * 工具结果的对外投影**不在此登记**：它随 `toolContributions` 的工具贡献声明
 * （见 `focus-tools.ts`），由宿主代登记，插件无法为内核/他人工具登记投影。
 */
import { z } from "zod";
import { idempotencyHeadersSchema, type PluginApiRegistry } from "@aervox/contracts";

export {
  termsExtractedEventDataSchema, TERMS_EXTRACTED_EVENT, termExploreKindSchema,
  termExploreRequestSchema, termExploreResponseSchema,
  type TermsExtractedEventData, type TermExploreKind, type TermExploreRequest, type TermExploreResponse,
} from '../contracts/terms.js';
import {
  termsExtractedEventDataSchema, TERMS_EXTRACTED_EVENT, termExploreRequestSchema, termExploreResponseSchema,
} from '../contracts/terms.js';

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

/** 登记并返回本次贡献的注销函数，须先于文档生成与请求处理。 */
export function registerFocusModeApiContract(registry: Pick<PluginApiRegistry, "registerPluginApiContribution">): () => void {
  return registry.registerPluginApiContribution({
    streamEventTypes: [TERMS_EXTRACTED_EVENT],
    eventProjections: { [TERMS_EXTRACTED_EVENT]: termsExtractedEventDataSchema },
    openApiRoutes: [
      {
        method: "post",
        path: "/v1/terms/explore",
        summary: "追问探索概念/术语（CAP-007 / CAP-002）",
        description: "支持深挖（child）、对比发散（related）与分支对话（branch）；分支创建可用 Idempotency-Key 重试，同键不同分支意图返回 409",
        tags: ["Focus"],
        body: termExploreRequestSchema,
        headers: idempotencyHeadersSchema,
        responses: {
          200: { description: "探索结果与关联思考问题", schema: termExploreResponseSchema },
          400: { description: "Invalid explore request" },
          409: { description: "Idempotency key reused with different branch intent" },
        },
      },
      {
        method: "post",
        path: "/v1/hierarchy/explore",
        summary: "层级追问探索（CAP-014 / CAP-007）",
        description: "与 `/v1/terms/explore` 同一处理器，语义侧重层级下钻",
        tags: ["Focus"],
        body: termExploreRequestSchema,
        headers: idempotencyHeadersSchema,
        responses: {
          200: { description: "探索结果与关联思考问题", schema: termExploreResponseSchema },
          400: { description: "Invalid explore request" },
          409: { description: "Idempotency key reused with different branch intent" },
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
