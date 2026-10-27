import type { PluginHostServices } from "@aervox/host-plugin-api";
import { campusStateSchema, type CampusStateSnapshot } from "../contracts/index.js";
import { createEmptyCampusState } from "../domain/planner.js";

export class CampusServiceError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}

export function requireCampusConfiguration(services: PluginHostServices) {
  if (!services.configuration) throw new CampusServiceError("campus_storage_unavailable", 503, "当前宿主尚未提供校园数据存储，请连接支持此插件的宿主。");
  return services.configuration;
}

export function parseCampusSnapshot(snapshot: {
  revision: number; values: Record<string, unknown>; lifecycleGeneration: string;
}): CampusStateSnapshot {
  // An uninitialized host may omit defaults. A durable revision missing its document
  // is incompatible configuration, never a successful empty personal workspace.
  const parsed = campusStateSchema.safeParse(snapshot.values.state === undefined && snapshot.revision === 0 ? createEmptyCampusState() : snapshot.values.state);
  if (!parsed.success) throw new CampusServiceError("campus_stored_state_invalid", 409, "已保存的校园数据不符合当前版本，请检查配置后重新加载。");
  return { state: parsed.data, revision: snapshot.revision, lifecycleGeneration: snapshot.lifecycleGeneration };
}

export async function readCampusState(services: PluginHostServices): Promise<CampusStateSnapshot> {
  return parseCampusSnapshot(await requireCampusConfiguration(services).read());
}
