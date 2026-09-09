/**
 * Aervox｜思隅 @aervox/repositories — study-material 仓储类型（自 types.ts 机械拆分）
 */
import type { MaterialSourceModel, MaterialVersionModel, StudyMaterialModel } from "./content.js";
import type { TenantContext } from "../../tenant.js";

export interface IStudyMaterialRepository {
  create(
    tenant: TenantContext,
    input: {
      id: string;
      goalId?: string;
      type: string;
      title: string;
      idempotencyKey?: string;
    },
  ): Promise<StudyMaterialModel>;
  get(tenant: TenantContext, id: string): Promise<StudyMaterialModel | null>;
  listByGoal(tenant: TenantContext, goalId: string): Promise<StudyMaterialModel[]>;
  listByTenant(tenant: TenantContext): Promise<StudyMaterialModel[]>;
  updateStatus(tenant: TenantContext, id: string, status: string): Promise<StudyMaterialModel | null>;
  softDelete(tenant: TenantContext, id: string): Promise<StudyMaterialModel | null>;
  getByIdempotencyKey(tenant: TenantContext, key: string): Promise<StudyMaterialModel | null>;

  createVersion(
    tenant: TenantContext,
    input: {
      id: string;
      materialId: string;
      content: string;
      format?: string;
      author?: string;
    },
  ): Promise<MaterialVersionModel>;
  getVersion(tenant: TenantContext, versionId: string): Promise<MaterialVersionModel | null>;
  listVersions(tenant: TenantContext, materialId: string): Promise<MaterialVersionModel[]>;
  editVersion(
    tenant: TenantContext,
    materialId: string,
    content: string,
    expectedVersion: number,
  ): Promise<MaterialVersionModel | null>;

  addSource(
    tenant: TenantContext,
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
  listSources(tenant: TenantContext, materialVersionId: string): Promise<MaterialSourceModel[]>;
  invalidateSources(tenant: TenantContext, materialVersionId: string): Promise<number>;
}

export interface SafetyIncidentModel {
  id: string;
  workspaceId: string;
  subjectUserId: string;
  category: string;
  severity: string;
  disposition: string;
  policyVersion: string;
  createdAt: string;
}
