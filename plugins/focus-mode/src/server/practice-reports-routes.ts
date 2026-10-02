/**
 * Aervox｜思隅 plugins/focus-mode — 自适应练习报告端点（P1 · CAP-016）
 *
 * CR-060：自 `apps/api/src/modules/learning/learning/cap016-017-routes.ts` 迁入。
 *
 * 覆盖：
 * - 练习报告创建（区分观测与推断）；
 * - 报告查询；
 * - 重置推断（保留原始作答）。
 *
 * 报告行归宿主持有，插件只做**响应转发**（`HostRecord` 不透明载荷），不解析字段，
 * 以免插件反向依赖宿主表结构。
 */
import type { PluginHostServices, PluginHttpEndpoint } from "@aervox/host-plugin-api";
import { createPracticeReportSchema } from "./contracts.js";

async function handleCreateReport(body: unknown, services: PluginHostServices) {
  const parsed = createPracticeReportSchema.safeParse(body);
  if (!parsed.success) {
    return { status: 400, payload: { error: "Validation failed", details: parsed.error.issues } };
  }
  const report = await services.learningFacts.writeReport({
    sessionId: parsed.data.sessionId,
    totalQuestions: parsed.data.totalQuestions,
    correctCount: parsed.data.correctCount,
    incorrectCount: parsed.data.incorrectCount,
    avgTimeSpentSec: parsed.data.avgTimeSpentSec,
    totalHintsUsed: parsed.data.totalHintsUsed,
    masteryPrediction: parsed.data.masteryPrediction,
    biasAssessment: parsed.data.biasAssessment,
    reportType: parsed.data.reportType,
  });
  return { status: 201, payload: report };
}

async function handleGetReport(reportId: string, services: PluginHostServices) {
  const report = await services.learningFacts.readReport(reportId);
  if (!report) {
    return { status: 404, payload: { error: "Report not found" } };
  }
  return { payload: report };
}

async function handleListReports(sessionId: string, services: PluginHostServices) {
  const items = await services.learningFacts.listReports(sessionId);
  return { payload: { items } };
}

async function handleResetInference(sessionId: string, services: PluginHostServices) {
  const report = await services.learningFacts.resetInference(sessionId);
  return { status: 201, payload: report };
}

/** 自适应练习报告端点贡献 */
export const focusModeReportEndpoints: PluginHttpEndpoint[] = [
  {
    method: "POST",
    path: "/v1/practice-reports",
    handler: (request, services) => handleCreateReport(request.body, services),
  },
  {
    method: "GET",
    path: "/v1/practice-reports/:reportId",
    handler: (request, services) => handleGetReport(request.params["reportId"] ?? "", services),
  },
  {
    method: "GET",
    path: "/v1/practice-sessions/:sessionId/reports",
    handler: (request, services) => handleListReports(request.params["sessionId"] ?? "", services),
  },
  {
    method: "POST",
    path: "/v1/practice-sessions/:sessionId/reset-inference",
    handler: (request, services) => handleResetInference(request.params["sessionId"] ?? "", services),
  },
];
