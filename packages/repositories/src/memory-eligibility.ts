/**
 * Aervox｜思隅 @aervox/repositories — 自动召回资格（单一真源）
 *
 * 主对话召回与主动回合上下文共用同一谓词：合格 = 未删除 + 已确认（verified）长期记忆
 * + 分级允许（public/normal）+ 自动召回期限有效（缺失即长期，非法/已过期即不合格）。
 *
 * 用途（`memory_long`）与撤权由宿主注入的 consent 闸门负责（见 recall 工厂），
 * 本谓词只做记录级资格判定；历史保留与召回资格分离（不合格不等于删除）。
 */

export interface AutoRecallEligibilityInput {
  isDeleted?: number | null;
  verificationStatus?: string | null;
  layer?: string | null;
  sensitivityClass?: string | null;
  aiRecallUntil?: string | null;
}

/** 自动召回允许的记忆分级（其余一律拒绝：sensitive/restricted/unknown/未分级） */
export const AUTO_RECALL_SENSITIVITY_ALLOWLIST: readonly string[] = ["public", "normal"];

/** 记录级自动召回资格（纯函数；不作为用户主动查看历史的权限判据） */
export function isAutoRecallEligible(record: AutoRecallEligibilityInput): boolean {
  if (record.isDeleted === 1) return false;
  if (record.verificationStatus !== "verified" || record.layer !== "long_term") return false;
  if (!AUTO_RECALL_SENSITIVITY_ALLOWLIST.includes(record.sensitivityClass ?? "")) return false;
  if (record.aiRecallUntil != null && !(Date.parse(record.aiRecallUntil) > Date.now())) return false;
  return true;
}
