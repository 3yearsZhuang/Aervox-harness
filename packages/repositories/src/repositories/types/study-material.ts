/**
 * Aervox｜思隅 @aervox/repositories — study-material 仓储类型（自 types.ts 机械拆分）
 */
import type { MaterialSourceModel, MaterialVersionModel, StudyMaterialModel } from "./content.js";
import type { LocalContext } from "../../local-context.js";

export interface IStudyMaterialRepository {
  create(
    tenant: LocalContext,
    input: {
      id: string;
      goalId?: string;
      type: string;
      title: string;
      idempotencyKey?: string;
    },
  ): Promise<StudyMaterialModel>;
  get(tenant: LocalContext, id: string): Promise<StudyMaterialModel | null>;
  listByGoal(tenant: LocalContext, goalId: string): Promise<StudyMaterialModel[]>;
  listByTenant(tenant: LocalContext): Promise<StudyMaterialModel[]>;
  updateStatus(tenant: LocalContext, id: string, status: string): Promise<StudyMaterialModel | null>;
  softDelete(tenant: LocalContext, id: string): Promise<StudyMaterialModel | null>;
  getByIdempotencyKey(tenant: LocalContext, key: string): Promise<StudyMaterialModel | null>;

  createVersion(
    tenant: LocalContext,
    input: {
      id: string;
      materialId: string;
      content: string;
      format?: string;
      author?: string;
    },
  ): Promise<MaterialVersionModel>;
  getVersion(tenant: LocalContext, versionId: string): Promise<MaterialVersionModel | null>;
  listVersions(tenant: LocalContext, materialId: string): Promise<MaterialVersionModel[]>;
  editVersion(
    tenant: LocalContext,
    materialId: string,
    content: string,
    expectedVersion: number,
  ): Promise<MaterialVersionModel | null>;

  addSource(
    tenant: LocalContext,
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
  listSources(tenant: LocalContext, materialVersionId: string): Promise<MaterialSourceModel[]>;
  invalidateSources(tenant: LocalContext, materialVersionId: string): Promise<number>;
}

export interface SafetyIncidentModel {
  id: string;
  workspaceId?: string;
  subjectUserId?: string;
  category: string;
  severity: string;
  disposition: string;
  policyVersion: string;
  createdAt: string;
}
