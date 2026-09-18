/**
 * Aervox｜思隅 @aervox/repositories — study-material 仓储类型（自 types.ts 机械拆分）
 */
import type { MaterialSourceModel, MaterialVersionModel, StudyMaterialModel } from "./content.js";
import type { LocalContext } from "../../local-context.js";

export interface IStudyMaterialRepository {
  create(
    ctx: LocalContext,
    input: {
      id: string;
      goalId?: string;
      type: string;
      title: string;
      idempotencyKey?: string;
    },
  ): Promise<StudyMaterialModel>;
  get(ctx: LocalContext, id: string): Promise<StudyMaterialModel | null>;
  listByGoal(ctx: LocalContext, goalId: string): Promise<StudyMaterialModel[]>;
  listByTenant(ctx: LocalContext): Promise<StudyMaterialModel[]>;
  updateStatus(ctx: LocalContext, id: string, status: string): Promise<StudyMaterialModel | null>;
  softDelete(ctx: LocalContext, id: string): Promise<StudyMaterialModel | null>;
  getByIdempotencyKey(ctx: LocalContext, key: string): Promise<StudyMaterialModel | null>;

  createVersion(
    ctx: LocalContext,
    input: {
      id: string;
      materialId: string;
      content: string;
      format?: string;
      author?: string;
    },
  ): Promise<MaterialVersionModel>;
  getVersion(ctx: LocalContext, versionId: string): Promise<MaterialVersionModel | null>;
  listVersions(ctx: LocalContext, materialId: string): Promise<MaterialVersionModel[]>;
  editVersion(
    ctx: LocalContext,
    materialId: string,
    content: string,
    expectedVersion: number,
  ): Promise<MaterialVersionModel | null>;

  addSource(
    ctx: LocalContext,
    input: {
      id: string;
      materialVersionId: string;
      sourceType: string;
      sourceUri?: string;
      sourceTitle?: string;
      licenseStatus?: string;
      verificationStatus?: string;
    },
  ): Promise<MaterialSourceModel>;
  listSources(ctx: LocalContext, materialVersionId: string): Promise<MaterialSourceModel[]>;
  invalidateSources(ctx: LocalContext, materialVersionId: string): Promise<number>;
}

export interface SafetyIncidentModel {
  id: string;
  category: string;
  severity: string;
  disposition: string;
  policyVersion: string;
  createdAt: string;
}
