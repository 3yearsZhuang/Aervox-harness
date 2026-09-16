/**
 * Aervox｜思隅 @aervox/api — 安全与危机干预服务
 *
 * 规则依据：PRD §4.3、§6.5、SRS FR-SAFE-001、AI_QUALITY_SAFETY.md §7。
 * 组合分类器、危机资源、情绪指引与审计仓储。
 */
import type {
  ISafetyRepository,
  LocalContext,
  SafetyIncidentModel,
} from "@aervox/repositories";
import type {
  RegionalHelpline,
  SafetyClassificationResult,
} from "@aervox/contracts";
import { classifySafety } from "./classifier.js";
import {
  formatCrisisResponse,
  formatDistressPromptGuidance,
  getCrisisHelplines,
  SAFETY_POLICY_VERSION,
} from "./crisis-resources.js";

export class SafetyService {
  constructor(private readonly safetyRepo: ISafetyRepository) {}

  /**
   * 对输入文本进行安全分类
   */
  classify(text: string): SafetyClassificationResult {
    return classifySafety(text);
  }

  /**
   * 获取当前生效的安全策略版本
   */
  getPolicyVersion(): string {
    return SAFETY_POLICY_VERSION;
  }

  /**
   * 获取地区求助热线资源列表
   */
  getHelplines(region?: string): RegionalHelpline[] {
    return getCrisisHelplines(region);
  }

  /**
   * 生成针对危机情况的不可篡改固定求助响应
   */
  getCrisisResponse(region?: string): string {
    return formatCrisisResponse(region);
  }

  /**
   * 获取中度情绪困扰与陪伴指引（注入系统提示词）
   */
  getDistressGuidance(): string {
    return formatDistressPromptGuidance();
  }

  /**
   * 记录安全事件（最小化审计记录，不记录未脱敏敏感正文）
   */
  async recordIncident(
    tenant: LocalContext,
    incident: {
      id?: string;
      category: string;
      severity: string;
      disposition: string;
      policyVersion?: string;
    },
  ): Promise<SafetyIncidentModel> {
    const id = incident.id ?? `sinc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    return this.safetyRepo.recordIncident(tenant, {
      id,
      category: incident.category,
      severity: incident.severity,
      disposition: incident.disposition,
      policyVersion: incident.policyVersion ?? this.getPolicyVersion(),
    });
  }

  /**
   * 查询安全事件审计记录
   */
  async listIncidents(tenant: LocalContext, limit = 50): Promise<SafetyIncidentModel[]> {
    return this.safetyRepo.listIncidents(tenant, limit);
  }
}
