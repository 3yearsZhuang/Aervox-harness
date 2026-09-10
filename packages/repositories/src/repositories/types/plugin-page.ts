/**
 * Aervox｜思隅 @aervox/repositories — plugin-page 仓储类型（自 types.ts 机械拆分）
 */
import type { PluginPageModel } from "./extension.js";

export interface IPluginPageRepository {
  upsertPage(page: {
    pluginId: string;
    pageId: string;
    title: unknown;
    description?: unknown;
    entry: string;
    capabilities: string[];
    checksum?: string | null;
  }): Promise<PluginPageModel>;
  listPages(pluginId: string): Promise<PluginPageModel[]>;
  getPage(pluginId: string, pageId: string): Promise<PluginPageModel | null>;
  deletePagesForPlugin(pluginId: string): Promise<void>;
}

export interface PersonaPreferencesModel {
  id: string;
  workspaceId?: string;
  subjectUserId?: string;
  /** 语气: "friendly" | "neutral" | "formal" */
  tone: string;
  /** 主动程度: "low" | "medium" | "high" */
  proactiveness: string;
  /** 称呼: "casual" | "formal" | "none" */
  addressForm: string;
  /** 提醒节奏: "gentle" | "moderate" | "frequent" */
  reminderCadence: string;
  /** 偏好版本号，每次修改递增 */
  version: number;
  /** 问卷是否已跳过 */
  skipped: boolean;
  createdAt: string;
  updatedAt: string;
}
