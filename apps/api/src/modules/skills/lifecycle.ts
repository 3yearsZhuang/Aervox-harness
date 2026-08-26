/**
 * Aervox｜思隅 @aervox/api — Skill Neo 生命周期服务（CAP-020）
 *
 * 流程：payload（不可变内容）→ candidate（绑定来源证据）→ evaluate →
 * promote（canary/stable release）→ rollback / sync。
 *
 * 规则依据：reference/AstrBot astrbot/core/tools/computer_tools/shipyard_neo/neo_skills.py
 * 与 neo_skill_sync.py。AstrBot 沙盒「执行证据」适配为 Aervox 业务对象
 * （turns / memory_records / learning_goals），见 reference-design-transfer.md。
 *
 * promote 联动（stable + syncToLocal）：
 * - payload.content.skill_markdown 落盘 <skillsRoot>/<skill_key>/SKILL.md；
 * - 注册进 skill_registrations（source=ai_authored，active=true）；
 * - release.synced_to_local 置 1。
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  SkillCandidateModel,
  SkillPayloadModel,
  SkillReleaseModel,
  SqliteSkillLifecycleRepository,
  SqliteSkillRegistryRepository,
} from "@aervox/database";
import { parseFrontmatter } from "./skill-manager.js";

export interface SkillLifecycleDeps {
  lifecycle: SqliteSkillLifecycleRepository;
  registry: SqliteSkillRegistryRepository;
  /** 技能内容落盘根目录（与 SkillManager 共享） */
  skillsRoot: string;
}

export class SkillNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillNotFoundError";
  }
}

export class SkillStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillStateError";
  }
}

let seq = 0;
const id = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}_${(++seq).toString(36)}`;

/** 从 payload.content 提取 skill_markdown 字符串 */
function extractSkillMarkdown(payload: SkillPayloadModel): string {
  const content = payload.content as { skill_markdown?: unknown };
  const markdown = content?.skill_markdown;
  if (typeof markdown !== "string" || markdown.trim().length === 0) {
    throw new SkillStateError("payload.content.skill_markdown must be a non-empty string");
  }
  return markdown;
}

export class SkillLifecycleService {
  constructor(private readonly deps: SkillLifecycleDeps) {}

  /** 创建不可变内容载荷（幂等：同 payloadRef 覆盖） */
  async createPayload(req: {
    payloadRef?: string;
    kind?: string;
    payload: unknown;
  }): Promise<SkillPayloadModel> {
    return this.deps.lifecycle.createPayload({
      payloadRef: req.payloadRef ?? id("skill_payload"),
      kind: req.kind,
      content: req.payload,
      checksum: createHash("sha256")
        .update(JSON.stringify(req.payload))
        .digest("hex"),
    });
  }

  getPayload(payloadRef: string): Promise<SkillPayloadModel | null> {
    return this.deps.lifecycle.getPayload(payloadRef);
  }

  /** 创建候选（绑定来源证据 + 可选载荷） */
  createCandidate(req: {
    skillKey: string;
    sourceEvidence?: {
      turnIds?: string[];
      memoryIds?: string[];
      learningItemIds?: string[];
    };
    payloadRef?: string | null;
    scenarioKey?: string | null;
  }): Promise<SkillCandidateModel> {
    return this.deps.lifecycle.createCandidate({
      candidateId: id("skill_cand"),
      skillKey: req.skillKey,
      sourceEvidence: {
        turnIds: req.sourceEvidence?.turnIds ?? [],
        memoryIds: req.sourceEvidence?.memoryIds ?? [],
        learningItemIds: req.sourceEvidence?.learningItemIds ?? [],
      },
      payloadRef: req.payloadRef ?? null,
      scenarioKey: req.scenarioKey ?? null,
    });
  }

  listCandidates(options?: { skillKey?: string; status?: string }): Promise<SkillCandidateModel[]> {
    return this.deps.lifecycle.listCandidates(options);
  }

  /** 评估候选：未通过 → rejected；通过 → evaluated */
  async evaluateCandidate(
    candidateId: string,
    evaluation: { passed: boolean; score?: number; report?: string },
  ): Promise<SkillCandidateModel> {
    const candidate = await this.deps.lifecycle.getCandidate(candidateId);
    if (!candidate) throw new SkillNotFoundError(`candidate not found: ${candidateId}`);
    if (candidate.status === "promoted" || candidate.status === "rejected") {
      throw new SkillStateError(`candidate already finalized: ${candidate.status}`);
    }
    const next = evaluation.passed ? "evaluated" : "rejected";
    const updated = await this.deps.lifecycle.updateCandidateStatus(candidateId, next);
    if (!updated) throw new SkillNotFoundError(`candidate not found: ${candidateId}`);
    return updated;
  }

  /**
   * 晋升候选为发布。stable + syncToLocal 时同步 payload.skill_markdown 到本地
   * SKILL.md 并注册进 skill_registrations（source=ai_authored）。
   */
  async promoteCandidate(
    candidateId: string,
    req: { stage?: "canary" | "stable"; syncToLocal?: boolean },
  ): Promise<SkillReleaseModel> {
    const stage = req.stage ?? "canary";
    const syncToLocal = req.syncToLocal ?? true;
    const candidate = await this.deps.lifecycle.getCandidate(candidateId);
    if (!candidate) throw new SkillNotFoundError(`candidate not found: ${candidateId}`);
    if (candidate.status === "rejected") {
      throw new SkillStateError("cannot promote a rejected candidate");
    }

    // 版本号：同 skillKey + stage 单调递增（缺省从 1 起）
    const releases = await this.deps.lifecycle.listReleases({ skillKey: candidate.skillKey, stage });
    const version = releases.reduce((max, r) => Math.max(max, r.version), 0) + 1;

    const release = await this.deps.lifecycle.createRelease({
      releaseId: id("skill_rel"),
      skillKey: candidate.skillKey,
      stage,
      candidateId: candidate.candidateId,
      payloadRef: candidate.payloadRef,
      version,
    });

    if (stage === "stable" && syncToLocal && candidate.payloadRef) {
      await this.syncReleaseToLocal(release.releaseId, release.skillKey, release.payloadRef ?? null);
      // 返回同步后的最新状态（synced_to_local=1）
      return (await this.deps.lifecycle.getRelease(release.releaseId)) ?? release;
    }

    await this.deps.lifecycle.updateCandidateStatus(candidateId, "promoted");
    return release;
  }

  listReleases(options?: {
    skillKey?: string;
    stage?: string;
    activeOnly?: boolean;
  }): Promise<SkillReleaseModel[]> {
    return this.deps.lifecycle.listReleases(options);
  }

  /**
   * 回滚：取消目标发布 active，并重新激活同 skillKey+stage 的最近一个历史发布
   * （如有）。stable 且已同步本地时不自动回滚本地文件（保留溯源），由 sync 显式管理。
   */
  async rollbackRelease(releaseId: string): Promise<{ rolledBack: SkillReleaseModel; restored: SkillReleaseModel | null }> {
    const target = await this.deps.lifecycle.getRelease(releaseId);
    if (!target) throw new SkillNotFoundError(`release not found: ${releaseId}`);

    const deactivated = await this.deps.lifecycle.deactivateRelease(releaseId);
    if (!deactivated) throw new SkillNotFoundError(`release not found: ${releaseId}`);

    // 重新激活同 skillKey + stage 的最近历史发布（排除被回滚者）
    const history = await this.deps.lifecycle.listReleases({
      skillKey: target.skillKey,
      stage: target.stage,
    });
    const previous = history
      .filter((r) => r.releaseId !== releaseId && r.version < target.version)
      .sort((a, b) => b.version - a.version)[0];
    const restored = previous
      ? await this.deps.lifecycle.setReleaseActive(previous.releaseId, true)
      : null;

    return { rolledBack: deactivated, restored };
  }

  /** 显式同步 stable 发布内容到本地 SKILL.md + 注册表 */
  async syncRelease(releaseId: string): Promise<SkillReleaseModel> {
    const release = await this.deps.lifecycle.getRelease(releaseId);
    if (!release) throw new SkillNotFoundError(`release not found: ${releaseId}`);
    if (release.stage !== "stable") {
      throw new SkillStateError("only stable releases can be synced to local");
    }
    return this.syncReleaseToLocal(releaseId, release.skillKey, release.payloadRef ?? null);
  }

  /** 落盘 + 注册 + 标记 synced（幂等：重复 sync 覆盖本地内容） */
  private async syncReleaseToLocal(
    releaseId: string,
    skillKey: string,
    payloadRef: string | null,
  ): Promise<SkillReleaseModel> {
    if (!payloadRef) throw new SkillStateError(`release ${releaseId} has no payload to sync`);
    const payload = await this.deps.lifecycle.getPayload(payloadRef);
    if (!payload) throw new SkillNotFoundError(`payload not found: ${payloadRef}`);
    const markdown = extractSkillMarkdown(payload);
    const frontmatter = parseFrontmatter(markdown);
    const meta = (payload.content as { meta?: { description?: string } }).meta;
    const description = frontmatter.description || meta?.description || `Skill: ${skillKey}`;

    const skillDir = path.join(this.deps.skillsRoot, skillKey);
    await fs.mkdir(skillDir, { recursive: true });
    const skillMd = path.join(skillDir, "SKILL.md");
    await fs.writeFile(skillMd, markdown, "utf8");

    await this.deps.registry.registerSkill({
      id: skillKey,
      name: skillKey,
      description,
      source: "ai_authored",
      active: true,
      checksum: createHash("sha256").update(markdown).digest("hex"),
      contentPath: skillMd,
    });

    const synced = await this.deps.lifecycle.markSyncedToLocal(releaseId);
    if (!synced) throw new SkillNotFoundError(`release not found: ${releaseId}`);
    return synced;
  }
}
