/**
 * Aervox｜思隅 @aervox/repositories — plugin-page 仓储类型（自 types.ts 机械拆分）
 */
import type { PluginPageModel } from "./extension.js";
import type { PluginModel } from "./recovery-ledger.js";

/** One SQL snapshot of the package and Page identities that authorize a resource read. */
export interface PluginPageResourceSnapshot {
  plugin: Pick<PluginModel, "id" | "enabled" | "availability" | "lifecycleGeneration" | "bundleGeneration">;
  page: Pick<PluginPageModel, "id" | "pluginId" | "pageId" | "entry"> | null;
}

export interface IPluginPageRepository {
  /** Each completed registration atomically replaces the persisted Page incarnation. */
  upsertPage(page: {
    pluginId: string;
    pageId: string;
    title: unknown;
    description?: unknown;
    entry: string;
    capabilities: string[];
    checksum?: string | null;
  }): Promise<PluginPageModel>;
  /** Rotate the captured incarnation after asset writes without restoring a stale Page declaration. */
  updatePageChecksum(pluginId: string, pageId: string, expectedPageGeneration: string, checksum: string): Promise<PluginPageModel | null>;
  listPages(pluginId: string, expectedLifecycleGeneration?: string): Promise<PluginPageModel[]>;
  getPage(pluginId: string, pageId: string): Promise<PluginPageModel | null>;
  /** Exact plugin/Page match, including a missing Page; no alias resolution or filesystem I/O. */
  getPageResourceSnapshot(pluginId: string, pageId: string): Promise<PluginPageResourceSnapshot | null>;
  deletePagesForPlugin(pluginId: string): Promise<void>;
}

export interface PersonaPreferencesModel {
  id: string;
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
