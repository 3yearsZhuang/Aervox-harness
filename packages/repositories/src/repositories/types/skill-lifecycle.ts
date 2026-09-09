/**
 * Aervox｜思隅 @aervox/repositories — skill-lifecycle 仓储类型（自 types.ts 机械拆分）
 */
import type { SkillCandidateModel, SkillPayloadModel, SkillReleaseModel } from "./mcp-server.js";

export interface ISkillLifecycleRepository {
  /** 创建载荷（幂等：同一 payloadRef 覆盖内容，checksum 同步） */
  createPayload(
    payload: { payloadRef: string; kind?: string; content: unknown; checksum?: string | null },
  ): Promise<SkillPayloadModel>;
  getPayload(payloadRef: string): Promise<SkillPayloadModel | null>;
  /** 创建候选（幂等：同一 candidateId 返回既有记录） */
  createCandidate(
    candidate: {
      candidateId: string;
      skillKey: string;
      sourceEvidence: { turnIds: string[]; memoryIds: string[]; learningItemIds: string[] };
      payloadRef?: string | null;
      scenarioKey?: string | null;
    },
  ): Promise<SkillCandidateModel>;
  getCandidate(candidateId: string): Promise<SkillCandidateModel | null>;
  listCandidates(options?: { skillKey?: string; status?: string }): Promise<SkillCandidateModel[]>;
  /** 更新候选状态（pending → evaluated/promoted/rejected） */
  updateCandidateStatus(
    candidateId: string,
    status: string,
  ): Promise<SkillCandidateModel | null>;
  /** 创建发布（幂等：同 skillKey+stage+version 返回既有；自动取消同 key+stage 旧 active） */
  createRelease(
    release: {
      releaseId: string;
      skillKey: string;
      stage: string;
      candidateId: string;
      payloadRef?: string | null;
      version: number;
    },
  ): Promise<SkillReleaseModel>;
  getRelease(releaseId: string): Promise<SkillReleaseModel | null>;
  listReleases(options?: { skillKey?: string; stage?: string; activeOnly?: boolean }): Promise<SkillReleaseModel[]>;
  /** 标记发布为已同步本地（synced_to_local=1） */
  markSyncedToLocal(releaseId: string): Promise<SkillReleaseModel | null>;
  /** 回滚：取消当前 active 发布（使旧发布重新可激活由调用方编排） */
  deactivateRelease(releaseId: string): Promise<SkillReleaseModel | null>;
  /** 设置发布 active 状态（回滚重新激活旧发布 / 取消激活用） */
  setReleaseActive(releaseId: string, active: boolean): Promise<SkillReleaseModel | null>;
}

export interface LLMConfigModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  /** 预设名称（多预设切换用） */
  name?: string;
  /** 是否激活（0/1） */
  isActive?: number;
  enabled: number;
  providerType: string;
  baseUrl: string;
  apiKey?: string | null;
  modelId: string;
  temperature: number;
  maxTokens?: number | null;
  settingsJson: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface LLMConfigSaveInput {
  enabled: boolean;
  providerType: string;
  baseUrl: string;
  apiKey?: string | null;
  modelId: string;
  temperature: number;
  maxTokens?: number;
  settings?: Record<string, unknown>;
}
