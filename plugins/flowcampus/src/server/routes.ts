import type { PluginHostServices, PluginHttpEndpoint, PluginHttpResponse } from "@aervox/host-plugin-api";
import { campusPlanQuerySchema, campusSaveRequestSchema } from "../contracts/index.js";
import { calculateCampusPlan } from "../domain/planner.js";
import { CampusServiceError, parseCampusSnapshot, readCampusState, requireCampusConfiguration } from "./state.js";

export const CAMPUS_STATE_PATH = "/v1/plugins/flowcampus/state";
export const CAMPUS_PLAN_PATH = "/v1/plugins/flowcampus/plan";

function failure(error: unknown): PluginHttpResponse {
  if (error instanceof CampusServiceError) return { status: error.status, payload: { code: error.code, message: error.message } };
  // Configuration faults are host-authored structured errors. Never echo unknown exceptions.
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    const code = error.code;
    if (/conflict|lifecycle|generation/.test(code)) return { status: 409, payload: { code, message: "校园数据或插件状态已改变，请重新加载后保存。" } };
    if (/unavailable|disabled|not_found/.test(code)) return { status: 503, payload: { code, message: "校园规划插件当前不可用，请检查宿主连接与启用状态。" } };
    if (/invalid|validation/.test(code)) return { status: 400, payload: { code, message: "校园数据格式或范围无效。" } };
  }
  throw error;
}

async function guarded(action: () => Promise<PluginHttpResponse>): Promise<PluginHttpResponse> {
  try { return await action(); } catch (error) { return failure(error); }
}

export function createFlowCampusEndpoints(now: () => Date = () => new Date()): PluginHttpEndpoint[] {
  return [
    { method: "GET", path: CAMPUS_STATE_PATH, handler: (_request, services) => guarded(async () => ({ payload: await readCampusState(services) })) },
    { method: "PUT", path: CAMPUS_STATE_PATH, handler: (request, services) => guarded(async () => {
      const parsed = campusSaveRequestSchema.safeParse(request.body);
      if (!parsed.success) return { status: 400, payload: { code: "campus_state_invalid", message: "请检查日程时间、地点关联和数据数量。", details: parsed.error.issues.map(issue => ({ path: issue.path.join("."), message: issue.message })) } };
      const snapshot = await requireCampusConfiguration(services).save({
        values: { state: parsed.data.state }, expectedRevision: parsed.data.expectedRevision,
        expectedLifecycleGeneration: parsed.data.expectedLifecycleGeneration,
      });
      return { payload: parseCampusSnapshot(snapshot) };
    }) },
    { method: "GET", path: CAMPUS_PLAN_PATH, handler: (request, services: PluginHostServices) => guarded(async () => {
      const parsed = campusPlanQuerySchema.safeParse(request.query);
      if (!parsed.success) return { status: 400, payload: { code: "campus_time_invalid", message: "查询时间必须包含时区偏移，且只接受 at 参数。" } };
      const snapshot = await readCampusState(services);
      const plan = calculateCampusPlan(snapshot.state, parsed.data.at ?? now());
      return { payload: { plan, revision: snapshot.revision, lifecycleGeneration: snapshot.lifecycleGeneration } };
    }) },
  ];
}
