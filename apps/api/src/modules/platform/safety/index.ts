/**
 * Aervox｜思隅 @aervox/api — 安全与危机干预模块入口
 *
 * 规则依据：PRD §4.3、§6.5、SRS FR-SAFE-001、AI_QUALITY_SAFETY.md §7。
 */
import type { ModuleDependencies } from "../../context.js";
import { SqliteSafetyRepository } from "@aervox/repositories";
import { SafetyService } from "./service.js";
import { registerSafetyRoutes } from "./routes.js";

export function registerSafetyModule(ctx: ModuleDependencies<"app" | "db">): SafetyService {
  const { app, db } = ctx;
  const repo = new SqliteSafetyRepository(db);
  const service = new SafetyService(repo);
  registerSafetyRoutes(app, service);
  return service;
}

export * from "./service.js";
export * from "./classifier.js";
export * from "./crisis-resources.js";

export type SafetyPort = Pick<import("./service.js").SafetyService, "classify" | "getPolicyVersion" | "getCrisisResponse" | "getDistressGuidance" | "recordIncident">;
