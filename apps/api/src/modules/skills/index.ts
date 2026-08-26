/**
 * Aervox｜思隅 @aervox/api — Skill 模块入口（CAP-020）
 *
 * 实例化注册表仓储 + SkillManager + SkillLifecycleService，注册 /v1/skills 路由，
 * 并把 Neo 生命周期操作登记为 aervox_skill_* 工具（ToolRuntime 存在时绑定 handler）。
 * skillsRoot 可注入（测试用临时目录）；缺省为 <repo>/data/skills。
 */
import type { FastifyInstance } from "fastify";
import {
  SqliteSkillLifecycleRepository,
  SqliteSkillRegistryRepository,
  SqliteToolRegistryRepository,
  type AervoxDatabase,
} from "@aervox/database";
import type { ToolRuntime } from "../tools/runtime.js";
import { registerSkillRoutes } from "./routes.js";
import { SkillManager } from "./skill-manager.js";
import { SkillLifecycleService } from "./lifecycle.js";
import { registerSkillLifecycleTools } from "./skill-tools.js";

export interface RegisterSkillsModuleOptions {
  /** 技能内容落盘根目录（缺省 <repo>/data/skills） */
  skillsRoot?: string;
  /** 工具运行时（由 tools 模块创建）；存在时绑定 aervox_skill_* handler */
  toolRuntime?: ToolRuntime;
}

export function registerSkillsModule(
  app: FastifyInstance,
  db: AervoxDatabase,
  options: RegisterSkillsModuleOptions = {},
): SkillManager {
  const registry = new SqliteSkillRegistryRepository(db);
  const manager = new SkillManager(registry, options.skillsRoot);

  // Neo 生命周期：服务 + 路由 + aervox_skill_* 工具登记/handler
  const lifecycle = new SkillLifecycleService({
    lifecycle: new SqliteSkillLifecycleRepository(db),
    registry,
    skillsRoot: manager.skillsRoot,
  });
  registerSkillRoutes(app, manager, lifecycle);

  const toolRegistry = new SqliteToolRegistryRepository(db);
  registerSkillLifecycleTools(toolRegistry, lifecycle, options.toolRuntime);
  return manager;
}
