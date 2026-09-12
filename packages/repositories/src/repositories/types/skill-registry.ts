/**
 * Aervox｜思隅 @aervox/repositories — skill-registry 仓储类型（自 types.ts 机械拆分）
 */
import type { SkillRegistrationModel } from "./mcp-server.js";

export interface ISkillRegistryRepository {
  /** 注册技能（幂等：同一 id 覆盖元数据，active/readonly 保持既有状态） */
  registerSkill(
    skill: {
      id: string;
      name: string;
      description: string;
      source?: string;
      active?: boolean;
      readonly?: boolean;
      version?: string;
      checksum?: string | null;
      pluginId?: string | null;
      gatingConditions?: unknown;
      contentPath?: string | null;
    },
  ): Promise<SkillRegistrationModel>;
  getSkill(id: string): Promise<SkillRegistrationModel | null>;
  listSkills(activeOnly?: boolean): Promise<SkillRegistrationModel[]>;
  /** 启停技能（plugin/系统只读例外由调用方决定） */
  setActive(id: string, active: boolean): Promise<SkillRegistrationModel | null>;
  /** 批量启停插件所属所有技能（O(1) 批量操作） */
  setSkillsActiveByPlugin(pluginId: string | string[], active: boolean): Promise<number>;
  /** 注销技能（readonly=1 拒绝；由调用方负责清理文件系统内容） */
  unregisterSkill(id: string): Promise<boolean>;
  /** 无条件移除技能（忽略 readonly，供插件卸载等内部生命周期使用；调用方负责清理文件系统） */
  removeSkill(id: string): Promise<boolean>;
  /** 批量无条件移除插件所属所有技能（O(1) 批量操作） */
  removeSkillsByPlugin(pluginId: string): Promise<number>;
  /** 记录最近引用时间（召回窗口淘汰用） */
  touchSkill(id: string): Promise<SkillRegistrationModel | null>;
  /** 导出运行时可调用快照（active + 门控过滤） */
  exportSkills(options?: {
    gatingEvaluator?: (condition: {
      field: string;
      operator: string;
      value?: unknown;
      evaluatorId?: string;
    }, context?: unknown) => boolean;
    gatingContext?: unknown;
  }): Promise<SkillRegistrationModel[]>;
}
