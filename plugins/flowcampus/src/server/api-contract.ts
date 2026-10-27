import type { PluginApiRegistry } from "@aervox/contracts";
import { campusPlanQuerySchema, campusPlanSnapshotSchema, campusSaveRequestSchema, campusStateSnapshotSchema } from "../contracts/index.js";
import { CAMPUS_PLAN_PATH, CAMPUS_STATE_PATH } from "./routes.js";

export function registerFlowCampusApiContract(registry: Pick<PluginApiRegistry, "registerPluginApiContribution">): () => void {
  return registry.registerPluginApiContribution({ openApiRoutes: [
    { method: "get", path: CAMPUS_STATE_PATH, summary: "读取校园规划数据快照", tags: ["Campus"],
      responses: { 200: { description: "同一版本的校园数据与生命周期标识", schema: campusStateSnapshotSchema }, 409: { description: "存储状态不符合当前插件契约" }, 503: { description: "持久化宿主不可用" } } },
    { method: "put", path: CAMPUS_STATE_PATH, summary: "按版本保存校园规划数据", tags: ["Campus"], body: campusSaveRequestSchema,
      description: "整文档 CAS 保存；expectedRevision 和 expectedLifecycleGeneration 必须来自读取快照，冲突时重新加载。",
      responses: { 200: { description: "保存后的新快照", schema: campusStateSnapshotSchema }, 400: { description: "输入或引用无效" }, 409: { description: "版本或插件生命周期已变化" }, 503: { description: "持久化宿主不可用" } } },
    { method: "get", path: CAMPUS_PLAN_PATH, summary: "确定性计算下一站和出发前任务", tags: ["Campus"], query: campusPlanQuerySchema,
      description: "无路线时明确不可用；保存的手工路线是估算，不查询真实地图，不创建系统通知。",
      responses: { 200: { description: "来自同一状态版本的规划", schema: campusPlanSnapshotSchema }, 400: { description: "时间或查询参数无效" }, 409: { description: "存储状态无效" }, 503: { description: "持久化宿主不可用" } } },
  ] });
}
